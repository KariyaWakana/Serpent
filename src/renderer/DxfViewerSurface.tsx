import { useEffect, useRef, useState } from 'react';
import { DxfViewer } from 'dxf-viewer';
import fontUrl from '../../resources/fonts/DejaVuSans.ttf?url';
import { useT } from './i18n';

type Props = {sourceUrl:string; enabled?:boolean; onOpenExternal:()=>void; onPresentationReady?:()=>void};
export function DxfViewerSurface({sourceUrl,enabled=true,onOpenExternal,onPresentationReady}:Props) {
  const t=useT();
  const container=useRef<HTMLDivElement>(null);
  const instance=useRef<DxfViewer|null>(null);
  const readyRef=useRef(onPresentationReady);
  readyRef.current=onPresentationReady;
  const [state,setState]=useState<'loading'|'ready'|'failed'>('loading');
  const [error,setError]=useState('');
  const [warning,setWarning]=useState(false);
  const [layers,setLayers]=useState<{name:string;visible:boolean}[]>([]);
  const [progress,setProgress]=useState(0);
  const fit=()=>{
    const v=instance.current,b=v?.GetBounds(),o=v?.GetOrigin();
    if(v&&b&&o)v.FitView(b.minX-o.x,b.maxX-o.x,b.minY-o.y,b.maxY-o.y);
  };
  useEffect(()=>{
    if(!enabled||!container.current)return;
    let alive=true;
    setState('loading');setError('');setWarning(false);setLayers([]);setProgress(0);
    let viewer:DxfViewer|null=null;
    const timeout=window.setTimeout(()=>{
      if(!alive)return;
      alive=false;viewer?.Destroy();instance.current=null;
      setError(t('preview.cadTimeout'));setState('failed');readyRef.current?.();
    },60_000);
    try {
      viewer=new DxfViewer(container.current,{autoResize:true,colorCorrection:true,
        sceneOptions:{suppressPaperSpace:true},preserveDrawingBuffer:true});
      if(!viewer.HasRenderer())throw new Error(t('preview.cadWebGL'));
      instance.current=viewer;
      viewer.Subscribe('message',event=>{if(alive&&event.detail?.level!=='info')setWarning(true);});
      void viewer.Load({url:sourceUrl,fonts:[fontUrl],
        workerFactory:()=>new Worker(new URL('./dxf-preview-worker.ts',import.meta.url),{type:'module'}),
        progressCbk:(phase,done,total)=>{if(alive&&phase==='fetch'&&total>0)setProgress(Math.round(100*done/total));},
      }).then(()=>{
        if(!alive)return;
        window.clearTimeout(timeout);
        const bounds=viewer?.GetBounds();
        if(!bounds)throw new Error(t('preview.cadEmpty'));
        setLayers(Array.from(viewer!.GetLayers(true),layer=>({name:layer.name,visible:(layer as {visible?:boolean}).visible!==false})));
        setState('ready');readyRef.current?.();
      }).catch((cause:unknown)=>{
        if(!alive)return;
        window.clearTimeout(timeout);setState('failed');setError(cause instanceof Error?cause.message:String(cause));
        readyRef.current?.();
      });
    }catch(cause){window.clearTimeout(timeout);setState('failed');setError(cause instanceof Error?cause.message:String(cause));readyRef.current?.();}
    return()=>{alive=false;window.clearTimeout(timeout);instance.current=null;viewer?.Destroy();container.current?.replaceChildren();};
  },[sourceUrl,enabled,t]);
  return <section className="preview-cad" aria-label={t('preview.cadTitle')}>
    <div className="preview-cad-toolbar"><strong>DXF</strong><span>{t('preview.cadModelSpace')}</span>
      <button type="button" onClick={fit} disabled={state!=='ready'}>{t('preview.cadFit')}</button>
      <button type="button" onClick={onOpenExternal}>{t('preview.openExternal')}</button>
    </div>
    <div className="preview-cad-body"><aside className="preview-cad-layers" aria-label={t('preview.cadLayers')}>
      <strong>{t('preview.cadLayers')} · {layers.length}</strong>
      {layers.map(layer=><label key={layer.name}><input type="checkbox" checked={layer.visible} onChange={event=>{
        instance.current?.ShowLayer(layer.name,event.target.checked);
        setLayers(items=>items.map(item=>item.name===layer.name?{...item,visible:event.target.checked}:item));
      }}/><span>{layer.name}</span></label>)}
    </aside><div className="preview-cad-canvas" ref={container} />
      {state==='loading'&&enabled?<div className="preview-cad-status" role="status">{t('preview.resolving')} {progress?`${progress}%`:''}</div>:null}
      {state==='failed'?<div className="preview-cad-status" role="status">{t('preview.cadFailed')}<p>{error}</p></div>:null}
    </div>
    <div className="preview-cad-notice">{t('preview.cadLimits')}{warning?` ${t('preview.cadWarning')}`:''}</div>
  </section>;
}
