import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import type { SerpentLibraryApi } from "../shared/library-api";
import { TEXT_VIEWER_MAX_BYTES, countTextLines } from "../shared/text-media";
import { LibraryOperationError, messageForPublicError, toMessage } from "./error-utils";
import { Icon } from "./Icons";
import { iconActionAttrs } from "./icon-action-attrs";
import { useLocale, useT } from "./i18n";
import { applyTextViewerTextareaLayout } from "./text-viewer-layout";
import { invalidateTextAssetPreviewCache } from "./TextAssetPreviewTile";
import { codeLanguage, highlightedCodeLines, matchingCodeLines } from './code-preview';

export type TextViewerControlsProps = {
  api: SerpentLibraryApi;
  libraryId: string;
  assetId: string;
  filename?: string;
  onClose: () => void;
  onPresentationReady?: () => void;
  onSaved?: () => void;
};

export type TextViewerControlsHandle = {
  save: () => Promise<boolean>;
  /** Persist edits and create a revision when the session changed, then allow close. */
  flushBeforeClose: () => Promise<boolean>;
};

/**
 * Numbered text viewer/editor (Serpent-sh7). Content is loaded via capped Worker
 * IPC — never via unbounded serpent://source fetch.
 */
let persistTextViewerWrap = true;

export const TextViewerControls = forwardRef<
  TextViewerControlsHandle,
  TextViewerControlsProps
>(function TextViewerControls(
  {
    api,
    libraryId,
    assetId,
    filename = '',
    onClose,
    onPresentationReady,
    onSaved,
  },
  ref,
) {
  const t = useT();
  const { locale } = useLocale();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [content, setContent] = useState("");
  const [baseline, setBaseline] = useState("");
  const [openedContent, setOpenedContent] = useState("");
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [editable, setEditable] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [wrap, setWrap] = useState(persistTextViewerWrap);
  const [actionError, setActionError] = useState<string | null>(null);
  const language = codeLanguage(filename);
  const [reading, setReading] = useState(Boolean(language));
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const codeRef = useRef<HTMLPreElement>(null);
  const matches = useMemo(() => matchingCodeLines(content, query), [content, query]);
  const highlighted = useMemo(() => highlightedCodeLines(content, language), [content, language]);
  const matchedLines = useMemo(() => new Set(matches), [matches]);
  const onSavedRef = useRef(onSaved);
  const contentRef = useRef(content);
  const baselineRef = useRef(baseline);
  const openedContentRef = useRef(openedContent);
  const editableRef = useRef(editable);
  const revisionIdRef = useRef(revisionId);
  const savingRef = useRef(saving);

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);
  useEffect(() => {
    baselineRef.current = baseline;
  }, [baseline]);
  useEffect(() => {
    openedContentRef.current = openedContent;
  }, [openedContent]);
  useEffect(() => {
    editableRef.current = editable;
  }, [editable]);
  useEffect(() => {
    revisionIdRef.current = revisionId;
  }, [revisionId]);
  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    applyTextViewerTextareaLayout(textarea, wrap);
  }, [wrap]);

  // Parent remounts with key=`${libraryId}:${assetId}` so loading starts true.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setActionError(null);
    void api
      .readTextAsset({ libraryId, assetId, maxBytes: TEXT_VIEWER_MAX_BYTES })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setActionError(result.error.message);
          setLoading(false);
          return;
        }
        setContent(result.value.content);
        setBaseline(result.value.content);
        setOpenedContent(result.value.content);
        setRevisionId(result.value.revisionId);
        setEditable(result.value.editable);
        setTruncated(result.value.truncated);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setActionError(
          error instanceof Error ? error.message : t("preview.textLoadFailed"),
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, assetId, libraryId, t]);

  const dirty = content !== baseline;
  const lineCount = useMemo(() => countTextLines(content), [content]);
  const gutter = useMemo(
    () =>
      Array.from({ length: lineCount }, (_, index) => String(index + 1)).join(
        "\n",
      ),
    [lineCount],
  );

  useEffect(() => {
    resizeTextarea();
  }, [content, lineCount, loading, wrap, reading, resizeTextarea]);

  useEffect(() => {
    if (loading) return;
    const textarea = textareaRef.current;
    const stage = textarea?.closest(".preview-text-scroll");
    if (!textarea || !(stage instanceof HTMLElement)) return;
    const observer = new ResizeObserver(() => {
      resizeTextarea();
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [loading, resizeTextarea]);

  useEffect(() => {
    if (!loading) onPresentationReady?.();
  }, [loading, onPresentationReady]);

  const save = useCallback(
    async (options?: { createRevision?: boolean }): Promise<boolean> => {
      const createRevision = options?.createRevision === true;
      const currentContent = contentRef.current;
      const currentBaseline = baselineRef.current;
      const currentOpened = openedContentRef.current;
      const currentEditable = editableRef.current;
      const currentRevisionId = revisionIdRef.current;
      if (!currentEditable || savingRef.current) return true;
      const needsWrite = currentContent !== currentBaseline;
      const needsRevision =
        createRevision && currentContent !== currentOpened;
      if (!needsWrite && !needsRevision) return true;

      setSaving(true);
      setActionError(null);
      try {
        const result = await api.saveTextAsset({
          libraryId,
          assetId,
          content: currentContent,
          expectedRevisionId: currentRevisionId ?? undefined,
          createRevision: needsRevision,
        });
        if (!result.ok) {
          if (result.error.code === "VERSION_CONFLICT") {
            try {
              const latest = await api.readTextAsset({
                libraryId,
                assetId,
                maxBytes: TEXT_VIEWER_MAX_BYTES,
              });
              if (latest.ok) {
                setRevisionId(latest.value.revisionId);
                setTruncated(latest.value.truncated);
                setEditable(latest.value.editable);
              }
            } catch {
              // Keep the conflict message below.
            }
          }
          setActionError(
            t("preview.textSaveFailedWithDetail", {
              detail: messageForPublicError(result.error, locale),
            }),
          );
          return false;
        }
        setBaseline(currentContent);
        if (needsRevision) {
          setOpenedContent(currentContent);
        }
        setRevisionId(result.value.revisionId);
        setTruncated(false);
        invalidateTextAssetPreviewCache(libraryId, assetId);
        onSavedRef.current?.();
        return true;
      } catch (error) {
        setActionError(
          error instanceof LibraryOperationError
            ? toMessage(error, t("preview.textSaveFailed"), locale)
            : error instanceof Error
              ? t("preview.textSaveFailedWithDetail", { detail: error.message })
              : t("preview.textSaveFailed"),
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [api, assetId, libraryId, locale, t],
  );

  const flushBeforeClose = useCallback(async (): Promise<boolean> => {
    if (!editableRef.current) return true;
    if (contentRef.current === openedContentRef.current) return true;
    return save({ createRevision: true });
  }, [save]);

  const handleClose = useCallback(async () => {
    if (!(await flushBeforeClose())) return;
    onClose();
  }, [flushBeforeClose, onClose]);

  useImperativeHandle(
    ref,
    () => ({
      save: () => save({ createRevision: false }),
      flushBeforeClose,
    }),
    [flushBeforeClose, save],
  );

  if (loading) {
    return (
      <div className="preview-text-stage" role="status">
        {t("preview.textLoading")}
      </div>
    );
  }

  return (
    <div className="preview-text-stage">
      <div className="preview-text-topbar">
        <div className="preview-text-meta" aria-live="polite">
          <span>
            {language ? `${filename.toLowerCase().endsWith('.ghx') ? 'GH XML' : language} · ` : ''}
            {t("preview.textLineCount", { count: lineCount })}
            {truncated ? ` · ${t("preview.textTruncated")}` : ""}
            {!editable ? ` · ${t("preview.textReadOnly")}` : ""}
          </span>
          {actionError ? (
            <button
              className="preview-text-error-btn"
              onClick={() => setActionError(null)}
              type="button"
            >
              {actionError}
            </button>
          ) : null}
        </div>
        <div className="preview-text-actions">
          {language ? <>
            <input aria-label={t('preview.codeSearch')} className="preview-code-search" placeholder={t('preview.codeSearch')}
              value={query} onChange={event => {setQuery(event.target.value);setMatchIndex(0);}} />
            <button type="button" className="preview-text-action is-code-label" disabled={!matches.length} onClick={()=>{
              const line=matches[matchIndex % matches.length];
              if (!reading) { setReading(true); }
              requestAnimationFrame(()=>codeRef.current?.querySelector(`[data-code-line="${line}"]`)?.scrollIntoView({block:'center'}));
              setMatchIndex(index=>index+1);
            }}>{matches.length ? `${(matchIndex % matches.length)+1}/${matches.length}` : t('preview.codeFind')}</button>
            {editable ? <button type="button" className="preview-text-action is-code-label" onClick={()=>setReading(value=>!value)}>
              {reading ? t('preview.codeEdit') : t('preview.codeRead')}
            </button> : null}
          </> : null}
          <button
            aria-pressed={wrap}
            className={`preview-text-action${wrap ? " is-active" : ""}`}
            onClick={() => {
              persistTextViewerWrap = !persistTextViewerWrap;
              setWrap(persistTextViewerWrap);
            }}
            type="button"
            {...iconActionAttrs(t("preview.textWrap"))}
          >
            <Icon name="wrap-text" size={14} />
          </button>
          {editable ? (
            <button
              className="preview-text-action"
              disabled={!dirty || saving}
              onClick={() => void save({ createRevision: false })}
              type="button"
              {...iconActionAttrs(
                saving ? t("preview.textSaving") : t("preview.textSave"),
              )}
            >
              <Icon name="save" size={14} />
            </button>
          ) : null}
          <button
            className="preview-text-action"
            onClick={() => void handleClose()}
            type="button"
            {...iconActionAttrs(t("common.close"))}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      <div className="preview-text-scroll">
        {reading ? <pre ref={codeRef} className={`preview-code-read${wrap ? ' is-wrap' : ''}`} aria-label={t('preview.codeRead')}>
          {highlighted.map((line,index)=><div key={index} data-code-line={index+1} className={matchedLines.has(index+1) ? 'is-match' : ''}>
            <span className="preview-code-number" aria-hidden="true">{index+1}</span>
            <code dangerouslySetInnerHTML={{__html:line || ' '}} />
          </div>)}
        </pre> :
        <div className={`preview-text-line-layer${wrap ? " is-wrap" : ""}`}>
          <pre aria-hidden="true" className="preview-text-gutter">
            {gutter}
          </pre>
          <textarea
            aria-label={t("preview.textEditorAria")}
            autoFocus={editable}
            className="preview-text-input"
            onChange={(event) => setContent(event.target.value)}
            readOnly={!editable}
            ref={textareaRef}
            spellCheck={false}
            value={content}
          />
        </div>
        }
      </div>
    </div>
  );
});
