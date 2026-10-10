import {expect,test} from 'vitest';
import {codeLanguage,highlightedCode,highlightedCodeLines,matchingCodeLines} from '../../src/renderer/code-preview';
import {isTextFileName} from '../../src/shared/text-media';
import {isSupportedDocumentExtension} from '../../src/shared/media-formats';
import {assetSupportsThumbnail} from '../../src/shared/thumbnail-support';

test('code and CAD formats are recognized without treating binary GH as code',()=>{
  for(const file of ['entry.MJS','module.cjs','definition.ghx'])expect(isTextFileName(file)).toBe(true);
  for(const file of ['definition.gh','Swan.gha','drawing.dwg'])expect(isTextFileName(file)).toBe(false);
  expect(codeLanguage('definition.GHX')).toBe('xml');expect(codeLanguage('Poisson.cs')).toBe('csharp');
  expect(isSupportedDocumentExtension('plan.DXF')).toBe(true);
  expect(isSupportedDocumentExtension('plan.dwg')).toBe(false);
  expect(assetSupportsThumbnail({mediaType:'document',displayName:'plan.dxf'})).toBe(false);
});
test('code preview escapes executable markup and keeps multiline highlighting balanced',()=>{
  const payload='<img src=x onerror="window.pwned=1">';
  const html=highlightedCode(payload,'xml');
  expect(html).not.toContain('<img');expect(html).toContain('&lt;');
  const lines=highlightedCodeLines('/* first\nsecond */\nconst x = 1;','javascript');
  expect(lines[1]).toContain('hljs-comment');
  for(const line of lines)expect((line.match(/<span/g)||[]).length).toBe((line.match(/<\/span>/g)||[]).length);
  expect(matchingCodeLines('A\r\nNeedleColumn\nneedle','NEEDLE')).toEqual([2,3]);
  expect(highlightedCode('<tag>'+ 'a'.repeat(100_000),'xml')).not.toContain('<tag>');
});
