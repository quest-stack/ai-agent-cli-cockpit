import { randomUUID } from "node:crypto";

import type { WebContents } from "electron";

// Keep temporary animation objects out of the page's own JavaScript namespace.
const CAPTURE_WORLD = 1004;

/** Compare a deterministic animation phase and restore the live preview afterwards. */
export async function freezePreviewAnimations(contents: WebContents, temporary = true): Promise<() => Promise<void>> {
  const key = JSON.stringify(`cockpit-capture-${randomUUID()}`);
  const restore = async (): Promise<void> => {
    if (contents.isDestroyed()) return;
    await contents.executeJavaScriptInIsolatedWorld(CAPTURE_WORLD, [{ code: `(()=>{
      const saved=globalThis[${key}];delete globalThis[${key}];if(!saved)return;
      for(const item of saved){try{item.animation.currentTime=item.time;if(item.state==='running')item.animation.play();}catch{}}
    })()` }]).catch(() => undefined);
  };
  try {
    await contents.executeJavaScriptInIsolatedWorld(CAPTURE_WORLD, [{ code: `(async()=>{
      const animations=document.getAnimations();if(animations.length>2000)throw Error('Too many animations');
      const saved=[];globalThis[${key}]=saved;
      for(const animation of animations){
        if(animation.playState!=='running'||(animation.currentTime!==null&&typeof animation.currentTime!=='number'))continue;
        saved.push({animation,time:animation.currentTime,state:animation.playState});animation.pause();
      }
      let timer;
      try{await Promise.race([
        Promise.all(saved.map(item=>item.animation.ready.catch(()=>{}))),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Animation pause timed out')),1500)})
      ])}finally{clearTimeout(timer)}
      for(const {animation} of saved){
        const timing=animation.effect?.getComputedTiming(),end=timing?.endTime;
        // Finite entrance effects are sampled just before completion; endless
        // pulses are sampled at their start. Avoid firing finish callbacks.
        animation.currentTime=typeof end==='number'&&Number.isFinite(end)?Math.max(0,end-0.001):0;
      }
    })()` }]);
    if (!temporary) {
      await contents.executeJavaScriptInIsolatedWorld(CAPTURE_WORLD, [{ code: `delete globalThis[${key}]` }]);
      return () => Promise.resolve();
    }
    return restore;
  } catch (error: unknown) { await restore(); throw error; }
}
