import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
vi.mock("./gh", async importOriginal => ({...await importOriginal<typeof import('./gh')>(),runGh:vi.fn(async()=>({code:0,stdout:'{}',stderr:''}))}));

test('a stale window cannot stamp comments onto a newer stored patch, or submit', async()=>{
 const {bb,harness}=createFakePluginHost({pluginId:'guided-review'});await plugin(bb);const store=createStore(bb);
 const meta={targetKey:'pr-1',kind:'pr' as const,repo:'example/project',number:1,headSha:'old',status:'ready' as const,createdAt:1};store.saveReview(meta);store.savePatch('pr-1','old patch');
 const old=await harness.behavior.callRpc('getReviewBundle',{targetKey:'pr-1'}) as any;
 store.saveReview({...meta,headSha:'new'});store.savePatch('pr-1','new patch');
 await expect(harness.behavior.callRpc('saveDraftComment',{targetKey:'pr-1',revision:old.revision,comment:{file:'a.ts',line:1,side:'RIGHT',body:'Old reasoning'}})).rejects.toThrow(/changed|latest/i);
 // The verdict doesn't depend on the diff, so it saves; submit still refuses the old window.
 await harness.behavior.callRpc('setVerdict',{targetKey:'pr-1',revision:old.revision,verdict:'APPROVE'});
 const submit=await harness.behavior.callRpc('submitReview',{targetKey:'pr-1',revision:old.revision,account:'casey',comments:[],body:'',verdict:'APPROVE'}) as any;expect(submit.ok).toBe(false);
 expect(store.getDraft('pr-1').comments).toEqual([]);await harness.lifecycle.dispose();
});
