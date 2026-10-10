import {mkdtempSync,copyFileSync,readFileSync,cpSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {_electron as electron,expect,test} from '@playwright/test';
test('packaged DWG converts locally, reuses its revision cache and displays geometry',async()=>{
  test.setTimeout(240000);
  const executablePath=process.env.SERPENT_E2E_PACKAGED_EXECUTABLE,source=process.env.SERPENT_E2E_DWG;
  if(!executablePath||!source)throw new Error('Provide packaged executable and a local DWG fixture.');
  const root=mkdtempSync(path.join(tmpdir(),'serpent-dwg-ui-'));const input=path.join(root,'drawing.dwg');copyFileSync(source,input);
  const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');const originalHash=hash(source);
  const app=await electron.launch({executablePath,args:[],env:{...process.env,SERPENT_E2E:'1',SERPENT_E2E_USER_DATA_PATH:path.join(root,'profile')}});
  try{
    await app.evaluate(({dialog},paths)=>{dialog.showOpenDialog=async(...args:unknown[])=>{const title=(args.at(-1) as {title?:string}).title;return {canceled:false,filePaths:[title==='Create Library'||title==='创建资源库'?paths.root:paths.input]};};},{root,input});
    const win=await app.firstWindow();
    await win.getByRole('button',{name:'创建资源库'}).click();await win.getByRole('textbox',{name:'名称'}).fill('DWG Test');await win.getByRole('button',{name:'创建',exact:true}).click();
    await expect(win.getByRole('button',{name:'当前资源库 DWG Test'})).toBeVisible();await expect(win.locator('.library-loading-backdrop')).toBeHidden();
    // Prepare through the public API; this test exercises CAD conversion, not
    // native focus restoration immediately after the create-library picker.
    await win.evaluate(async()=>{const api=(window as any).serpent.library;const libs=await api.listOpen();const result=await api.importFiles({libraryId:libs.value[0].libraryId});if(!result.ok)throw new Error(JSON.stringify(result));});
    await win.getByRole('button',{name:'刷新磁盘变化'}).click();await expect(win.getByText('drawing.dwg',{exact:true}).first()).toBeVisible({timeout:30000});
    const result=await win.evaluate(async()=>{const api=(window as any).serpent.library;const libs=await api.listOpen();const libraryId=libs.value[0].libraryId;const assets=await api.listAssets({libraryId,recursive:true});const asset=assets.value.find((a:any)=>a.relativeFilePath.endsWith('drawing.dwg'));
      if(asset.mediaType!=='document')throw new Error('DWG not recognized');
      const request={libraryId,assetId:asset.assetId,mode:'client',intent:'viewer'};
      const [one,two]=await Promise.all([api.requestPreview(request),api.requestPreview(request)]);if(!one.ok||!two.ok)throw new Error(JSON.stringify([one,two]));
      const again=await api.requestPreview(request);return {one:one.value,two:two.value,again:again.value};});
    expect(result.one.status).toBe('ready');expect(result.two.url).toBe(result.one.url);expect(result.again.url).toBe(result.one.url);expect(result.one.url).toContain('serpent://preview/');
    await win.getByText('drawing.dwg',{exact:true}).first().dblclick();await expect(win.getByRole('region',{name:'CAD 图纸预览'})).toBeVisible();await expect(win.getByRole('button',{name:'适合窗口'})).toBeEnabled({timeout:90000});
    expect(await win.locator('.preview-cad-layers input').count()).toBeGreaterThan(0);await expect(win.locator('.preview-cad-toolbar strong')).toHaveText('DWG');
    await expect(win.getByText('DWG 已在本机转换并缓存为 DXF 预览，原文件保持不变。',{exact:false})).toBeVisible();
    await win.screenshot({path:test.info().outputPath('dwg-preview.png')});
    expect(hash(source)).toBe(originalHash);expect(hash(path.join(root,'DWG Test/Assets/drawing.dwg'))).toBe(originalHash);
  }finally{await app.close();cpSync(path.join(root,'profile/logs'),test.info().outputPath('logs'),{recursive:true});await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});}
});
