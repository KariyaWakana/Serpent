import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import csharp from 'highlight.js/lib/languages/csharp';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import cpp from 'highlight.js/lib/languages/cpp';

for (const [name, grammar] of Object.entries({javascript, typescript, python, csharp, xml, json, css, bash, powershell, yaml, sql, cpp})) {
  hljs.registerLanguage(name, grammar);
}
const languages: Record<string, string> = {
  js:'javascript', mjs:'javascript', cjs:'javascript', jsx:'javascript', ts:'typescript', tsx:'typescript',
  py:'python', cs:'csharp', ghx:'xml', xml:'xml', plist:'xml', json:'json', css:'css', sh:'bash',
  ps1:'powershell', yaml:'yaml', yml:'yaml', sql:'sql', c:'cpp', cpp:'cpp', h:'cpp', hpp:'cpp',
};
export function codeLanguage(filename: string): string | null {
  return languages[filename.toLowerCase().split('.').at(-1) ?? ''] ?? null;
}
export function escapeCode(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
}
/** No auto-detection or code evaluation. Large files remain plain, selectable text. */
export function highlightedCode(text: string, language: string | null): string {
  if (!language || text.length > 100_000 || !hljs.getLanguage(language)) return escapeCode(text);
  try { return hljs.highlight(text, {language, ignoreIllegals:true}).value; }
  catch { return escapeCode(text); }
}
export function matchingCodeLines(text: string, query: string): number[] {
  if (!query.trim()) return [];
  const needle=query.toLocaleLowerCase();
  return text.split(/\r\n|\r|\n/).flatMap((line,index)=>line.toLocaleLowerCase().includes(needle)?[index+1]:[]);
}

/** Balance highlight.js span markup per line, including multiline strings/comments. */
export function highlightedCodeLines(text: string, language: string | null): string[] {
  const html=highlightedCode(text.replace(/\r\n|\r/g,'\n'),language);
  const stack:string[]=[];
  return html.split('\n').map(line=>{
    const prefix=stack.join('');
    for(const match of line.matchAll(/<span\b[^>]*>|<\/span>/g)) {
      if(match[0]==='</span>')stack.pop();else stack.push(match[0]);
    }
    return prefix+line+'</span>'.repeat(stack.length);
  });
}
