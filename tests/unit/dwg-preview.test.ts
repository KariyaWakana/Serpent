import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe,it,expect,vi} from 'vitest';
vi.mock('node:child_process',()=>({execFile:vi.fn()}));
import {execFile} from 'node:child_process';
import {convertDwgToDxf} from '../../src/worker/dwg-preview';
const dxf='0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n';
async function fixture(work:(source:string)=>Promise<void>){const dir=mkdtempSync(path.join(tmpdir(),'dwg-test-'));const source=path.join(dir,'中文 source.dwg');writeFileSync(source,'AC1024fixture');try{await work(source);}finally{rmSync(dir,{recursive:true,force:true});}}
function mockConvert(action?:(args:string[])=>void){vi.mocked(execFile).mockImplementation(((exe:string,args:string[],options:unknown,callback:(error:unknown)=>void)=>{writeFileSync(args[args.indexOf('-o')+1]!,dxf);action?.(args);callback(null);return {};} ) as typeof execFile);}
describe('local DWG conversion boundary',()=>{
  it('uses shell-free arguments, ASCII scratch names, and preserves the original',async()=>fixture(async source=>{
    mockConvert();const before=readFileSync(source);const output=await convertDwgToDxf(source,'converter.exe');
    expect(Buffer.from(output).toString()).toBe(dxf);expect(readFileSync(source)).toEqual(before);
    const [exe,args,options]=vi.mocked(execFile).mock.calls.at(-1)!;
    expect(exe).toBe('converter.exe');expect((args as string[]).at(-1)).toMatch(/source\.dwg$/);expect((args as string[]).at(-1)).not.toBe(source);
    expect(options).toMatchObject({windowsHide:true,timeout:90000});expect(options).not.toHaveProperty('shell');
  }));
  it('rejects source changes while conversion is in progress',async()=>fixture(async source=>{
    mockConvert(()=>writeFileSync(source,'AC1024source changed'));
    await expect(convertDwgToDxf(source)).rejects.toMatchObject({code:'DWG_SOURCE_CHANGED'});
  }));
  it('rejects a renamed non-DWG file before invoking the converter',async()=>fixture(async source=>{
    writeFileSync(source,'not a DWG');vi.mocked(execFile).mockClear();
    await expect(convertDwgToDxf(source)).rejects.toMatchObject({code:'DWG_PREVIEW_INVALID'});expect(execFile).not.toHaveBeenCalled();
  }));
  it('reports a missing executable without exposing process stderr',async()=>fixture(async source=>{
    vi.mocked(execFile).mockImplementation(((exe:unknown,args:unknown,options:unknown,callback:(e:unknown)=>void)=>{callback(Object.assign(new Error('private paths'),{code:'ENOENT'}));return {};} ) as typeof execFile);
    await expect(convertDwgToDxf(source,'missing.exe')).rejects.toMatchObject({code:'DWG_CONVERTER_NOT_FOUND',message:'DWG_CONVERTER_NOT_FOUND'});
  }));
});
