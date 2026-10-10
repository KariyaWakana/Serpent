import {execFile} from 'node:child_process';
import {copyFile,readFile,mkdtemp,rm,stat,open} from 'node:fs/promises';
import {statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// The decoder is a separately installed executable, not a linked dependency.
export const DWG_PREVIEW_VERSION='libredwg-dxf-preview-v1';
export class DwgPreviewError extends Error {
  constructor(readonly code:string){super(code);}
}
export function resolveDwgConverter():string {
  if(process.env.SERPENT_DWG_CONVERTER_PATH)return process.env.SERPENT_DWG_CONVERTER_PATH;
  const name=process.platform==='win32'?'dwg2dxf.exe':'dwg2dxf';
  const candidates=[
    ...(typeof process.resourcesPath==='string'?[path.join(process.resourcesPath,'cad-tools','libredwg',name)]:[]),
    path.join(process.cwd(),'local-tools','libredwg',name),
  ];
  return candidates.find(p=>{try{return statSync(p).isFile();}catch{return false;}})??name;
}
export function dwgConverterFingerprint(executable:string):string|null {
  try {
    const s=statSync(executable);let fingerprint=`${s.size}:${s.mtimeMs}`;
    // Windows releases keep the decoder implementation in a companion DLL.
    try{const dll=statSync(path.join(path.dirname(executable),'libredwg-0.dll'));fingerprint+=`:${dll.size}:${dll.mtimeMs}`;}catch{/* Other platforms use their own loader. */}
    return fingerprint;
  }catch{return null;}
}
let queue:Promise<unknown>=Promise.resolve();
export function convertDwgToDxf(source:string,executable=resolveDwgConverter()):Promise<Uint8Array> {
  const work=queue.catch(()=>undefined).then(()=>runConverter(source,executable));
  queue=work;return work;
}
async function runConverter(source:string,executable:string):Promise<Uint8Array>{
  const before=await stat(source);
  if(before.size>256*1024*1024)throw new DwgPreviewError('DWG_PREVIEW_TOO_LARGE');
  const handle=await open(source,'r');const prefix=Buffer.alloc(6);
  try{await handle.read(prefix,0,6,0);}finally{await handle.close();}
  const head=prefix.toString('ascii');
  if(!/^AC10\d{2}$/.test(head))throw new DwgPreviewError('DWG_PREVIEW_INVALID');
  // An ASCII basename avoids legacy Windows decoder filename/codepage issues.
  const scratch=await mkdtemp(path.join(tmpdir(),'serpent-dwg-'));
  try{
    const input=path.join(scratch,'source.dwg'),output=path.join(scratch,'preview.dxf');
    await copyFile(source,input);
    await new Promise<void>((resolve,reject)=>execFile(executable,['-v0','--as','r2010','-o',output,input],
      {cwd:scratch,windowsHide:true,timeout:90_000,maxBuffer:2*1024*1024},error=>{
        if(error){reject(new DwgPreviewError((error as NodeJS.ErrnoException).code==='ENOENT'?'DWG_CONVERTER_NOT_FOUND':error.killed?'DWG_PREVIEW_TIMEOUT':'DWG_PREVIEW_FAILED'));}
        else resolve();
      }));
    const after=await stat(source);
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new DwgPreviewError('DWG_SOURCE_CHANGED');
    const size=(await stat(output)).size;
    if(size===0||size>256*1024*1024)throw new DwgPreviewError('DWG_PREVIEW_TOO_LARGE');
    const bytes=await readFile(output);
    if(!/\bSECTION\b/.test(bytes.subarray(0,4096).toString('ascii'))||!/\bEOF\s*$/.test(bytes.subarray(-100).toString('ascii')))throw new DwgPreviewError('DWG_PREVIEW_INVALID');
    return bytes;
  }finally{await rm(scratch,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}
