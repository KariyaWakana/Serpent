import {mkdtempSync,writeFileSync,copyFileSync,readFileSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {_electron as electron,expect,test} from '@playwright/test';

test('packaged DXF and code previews load actual assets without changing sources',async()=>{
  test.setTimeout(150_000);
  const executablePath=process.env.SERPENT_E2E_PACKAGED_EXECUTABLE;
  if(!executablePath)throw new Error('Set SERPENT_E2E_PACKAGED_EXECUTABLE.');
  const root=mkdtempSync(path.join(tmpdir(),'serpent-cad-code-'));
  // A private source can be supplied locally; none is committed to the repository.
  const realDxf=process.env.SERPENT_E2E_DXF;
  const sourcePath=path.join(root,'drawing.dxf');
  if(realDxf)copyFileSync(realDxf,sourcePath);else writeFileSync(sourcePath,
    '0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n2\n0\nLAYER\n2\nWalls\n70\n0\n62\n7\n6\nCONTINUOUS\n0\nLAYER\n2\nFixtures\n70\n0\n62\n3\n6\nCONTINUOUS\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nWalls\n10\n0\n20\n0\n11\n100\n21\n80\n0\nCIRCLE\n8\nFixtures\n10\n40\n20\n30\n40\n10\n0\nENDSEC\n0\nEOF\n');
  const scriptPath=path.join(root,'example.mjs');
  writeFileSync(scriptPath,'/* first\nsecond */\nconst needle = "<img src=x onerror=alert(1)>";\nconsole.log(needle);');
  const ghxPath=path.join(root,'definition.ghx');writeFileSync(ghxPath,'<?xml version="1.0"?><Archive><items /></Archive>');
  const largePath=path.join(root,'large.py');writeFileSync(largePath,'#'.repeat(1024*1024+20));
  const app=await electron.launch({executablePath,args:[],env:{...process.env,SERPENT_E2E:'1',SERPENT_E2E_USER_DATA_PATH:path.join(root,'profile')}});
  try{
    await app.evaluate(({dialog},p)=>{dialog.showOpenDialog=async(...args:unknown[])=>{
      const title=(args.at(-1) as {title?:string}).title;
      return {canceled:false,filePaths:title==='Create Library'||title==='创建资源库'?[p.root]:[p.sourcePath,p.scriptPath,p.ghxPath,p.largePath]};
    };},{root,sourcePath,scriptPath,ghxPath,largePath});
    const win=await app.firstWindow();
    await win.getByRole('button',{name:'创建资源库'}).click();
    await win.getByRole('textbox',{name:'名称'}).fill('Preview Test');
    await win.getByRole('button',{name:'创建',exact:true}).click();
    await expect(win.getByRole('button',{name:'当前资源库 Preview Test'})).toBeVisible();
    await win.evaluate(async()=>{const api=(window as any).serpent.library;const libs=await api.listOpen();
      const page=await api.openBrowseSession({libraryId:libs.value[0].libraryId,query:null,limit:100});
      if(page.ok)await api.closeBrowseSession({libraryId:libs.value[0].libraryId,sessionId:page.value.sessionId});});
    await win.evaluate(async()=>{const api=(window as any).serpent.library;const libs=await api.listOpen();const result=await api.importFiles({libraryId:libs.value[0].libraryId});if(!result.ok)throw new Error(JSON.stringify(result));});
    await win.getByRole('button',{name:'刷新磁盘变化'}).click();
    await expect(win.getByText('drawing.dxf',{exact:true}).first()).toBeVisible({timeout:30000});
    await win.getByText('drawing.dxf',{exact:true}).first().dblclick();
    await expect(win.getByRole('region',{name:'CAD 图纸预览'})).toBeVisible();
    await expect(win.getByRole('button',{name:'适合窗口'})).toBeEnabled({timeout:65_000});
    const canvas=win.locator('.preview-cad-canvas canvas');await expect(canvas).toBeVisible();
    const bounds=await canvas.boundingBox();expect(bounds!.width).toBeGreaterThan(100);expect(bounds!.height).toBeGreaterThan(100);
    expect(await win.locator('.preview-cad-layers input').count()).toBeGreaterThan(0);
    const firstLayer=win.locator('.preview-cad-layers input').first();const checked=await firstLayer.isChecked();
    await firstLayer.setChecked(!checked);await expect(firstLayer).toBeChecked({checked:!checked});await firstLayer.setChecked(checked);
    await win.getByRole('button',{name:'适合窗口'}).click();
    await win.screenshot({path:test.info().outputPath(realDxf?'real-dxf.png':'fixture-dxf.png')});
    await win.keyboard.press('Escape');
    await win.getByText('example.mjs',{exact:true}).first().dblclick();
    await expect(win.getByLabel('阅读代码')).toBeVisible();
    await expect(win.locator('.preview-code-read .hljs-keyword')).toHaveCount(1);
    await expect(win.locator('.preview-code-read img')).toHaveCount(0);
    await win.getByLabel('查找代码').fill('needle');await win.getByRole('button',{name:'1/2'}).click();
    await expect(win.locator('.preview-code-read .is-match')).toHaveCount(2);
    await win.getByRole('button',{name:'编辑源码'}).click();
    const editor=win.getByRole('textbox',{name:'文本内容'});await expect(editor).toBeEditable();
    await editor.fill('const updated = 2;');await win.getByRole('button',{name:'保存',exact:true}).click();
    await win.keyboard.press('Escape');
    await win.getByText('definition.ghx',{exact:true}).first().dblclick();
    await expect(win.getByLabel('阅读代码')).toBeVisible();await expect(win.getByRole('button',{name:'编辑源码'})).toHaveCount(0);
    await win.screenshot({path:test.info().outputPath('ghx-code.png')});await win.keyboard.press('Escape');
    const checks=await win.evaluate(async()=>{
      const api=(window as any).serpent.library;const libs=await api.listOpen();const id=libs.value[0].libraryId;
      const page=await api.openBrowseSession({libraryId:id,query:null,limit:100});
      if(!page.ok)throw new Error('No browse session');
      const find=(name:string)=>page.value.items.find((a:any)=>a.displayName===name).assetId;
      const edited=await api.readTextAsset({libraryId:id,assetId:find('example.mjs')});
      const large=await api.readTextAsset({libraryId:id,assetId:find('large.py')});
      const denied=await api.saveTextAsset({libraryId:id,assetId:find('large.py'),content:'# shortened'});
      const ghDenied=await api.saveTextAsset({libraryId:id,assetId:find('definition.ghx'),content:'<overwritten/>'});
      await api.closeBrowseSession({libraryId:id,sessionId:page.value.sessionId});
      return {edited,large,denied,ghDenied};
    });
    expect(checks.edited).toMatchObject({ok:true,value:{content:'const updated = 2;'}});
    expect(checks.large).toMatchObject({ok:true,value:{truncated:true,editable:false}});
    expect(checks.denied.ok).toBe(false);expect(checks.ghDenied.ok).toBe(false);
    // The edit only modifies the managed copy; the original input is intact.
    expect(readFileSync(scriptPath,'utf8')).toContain('const needle');
    expect(readFileSync(ghxPath,'utf8')).toContain('<Archive>');
  }finally{await app.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});}
});
