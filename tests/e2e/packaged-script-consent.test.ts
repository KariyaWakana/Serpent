import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('packaged script review stays in-app, cancels without writes, and runs the reviewed source', async () => {
  const executablePath=process.env.SERPENT_E2E_PACKAGED_EXECUTABLE;
  if(!executablePath)throw new Error('Set SERPENT_E2E_PACKAGED_EXECUTABLE.');
  const root=mkdtempSync(path.join(tmpdir(),'serpent-in-app-consent-'));
  const sourcePath=path.join(root,'consent-test.txt');writeFileSync(sourcePath,'test asset');
  const application=await electron.launch({executablePath,args:[],env:{...process.env,SERPENT_E2E:'1',SERPENT_E2E_USER_DATA_PATH:path.join(root,'profile')}});
  try {
    await application.evaluate(({dialog}, paths)=>{
      dialog.showOpenDialog=async(...args:unknown[])=>{
        const title=(args.at(-1) as {title?:string}).title;
        return {canceled:false,filePaths:[title==='Create Library'||title==='创建资源库'?paths.root:paths.sourcePath]};
      };
      // Any native warning is a regression. Count it and fail the request.
      const state={calls:0};(globalThis as any).__nativeScriptDialogs=state;
      dialog.showMessageBox=(async()=>{state.calls++;throw new Error('Unexpected native message box');}) as typeof dialog.showMessageBox;
    },{root,sourcePath});
    const window=await application.firstWindow();
    await window.getByRole('button',{name:'创建资源库'}).click();
    await window.getByRole('textbox',{name:'名称'}).fill('Consent Test');
    await window.getByRole('button',{name:'创建',exact:true}).click();
    await expect(window.getByRole('button',{name:'当前资源库 Consent Test'})).toBeVisible();
    await window.getByRole('button',{name:'导入文件',exact:true}).first().click();
    await expect(window.getByText('consent-test.txt',{exact:true}).first()).toBeVisible();
    await window.getByRole('button',{name:'更多工具'}).click();
    await window.getByRole('menuitem',{name:'自动化脚本'}).click();
    const dialog=window.getByRole('dialog',{name:'自动化脚本'});
    const editor=dialog.getByRole('textbox',{name:'脚本',exact:true});
    const script=`const page=await serpent.assets.list({limit:1});
      const {metadata}=await serpent.assets.getMetadata(page.items[0].id);
      await serpent.assets.setMetadata({assetId:metadata.assetId,expectedVersion:metadata.entityVersion,description:'reviewed note'});
      const tag=await serpent.tags.create('reviewed tag');
      await serpent.tags.assign([metadata.assetId],[tag.id]);
      const collection=await serpent.collections.create('reviewed collection');
      await serpent.collections.addAssets(collection.id,[metadata.assetId]);
      const {metadata:after}=await serpent.assets.getMetadata(metadata.assetId);
      return {description:after.description,tag:tag.name,collection:collection.name};`;
    await editor.fill(script);
    await dialog.getByRole('button',{name:'运行',exact:true}).click();
    await expect(dialog.getByRole('region',{name:'运行前确认'})).toBeVisible();
    await expect(dialog.getByText('返回结果',{exact:true})).toHaveCount(0);
    await expect(editor).toBeHidden();
    await expect(dialog.getByRole('button',{name:'确认并运行'})).toBeEnabled();
    await window.screenshot({path:test.info().outputPath('in-app-script-review.png'),animations:'disabled'});
    await dialog.getByRole('button',{name:'返回编辑'}).click();
    await expect(editor).toHaveValue(script);
    await expect(dialog.getByText('返回结果',{exact:true})).toHaveCount(0);
    // Main rejects omitted or false approval; no runtime or native dialog is used.
    for(const confirmed of [undefined,false]) {
      const denied=await window.evaluate(async confirmed=>{
        const api=(window as any).serpent;
        const libraries=await api.library.listOpen();
        return api.automation.start({libraryId:libraries.value[0].libraryId,source:'return 99;',...(confirmed===undefined?{}:{confirmed})});
      },confirmed);
      expect(denied).toMatchObject({ok:false,error:{code:'CANCELLED'}});
    }
    await dialog.getByRole('button',{name:'运行',exact:true}).click();
    await dialog.getByRole('button',{name:'确认并运行'}).click();
    await expect(dialog.getByText('返回结果',{exact:true})).toBeVisible();
    await expect(dialog.locator('pre').first()).toContainText('reviewed note');
    await expect(dialog.locator('pre').first()).toContainText('reviewed tag');
    await expect(dialog.locator('pre').first()).toContainText('reviewed collection');
    expect(await application.evaluate(()=> (globalThis as any).__nativeScriptDialogs.calls)).toBe(0);
    await window.screenshot({path:test.info().outputPath('in-app-script-completed.png')});
  } finally {
    await application.close();
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
});


