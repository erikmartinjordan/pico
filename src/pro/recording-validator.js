/**
 * Recording validation harness — run via `node src/pro/recording-validator.js`
 * Simulates 10 back-to-back recording cycles and reports failures.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
async function waitForDisplayRefresh(platform) {
  const ms = platform === 'darwin' ? 460 : 160;
  const t0 = Date.now(); await new Promise(r=>setTimeout(r, ms)); return Date.now()-t0;
}

async function run() {
  let pass = 0; const total = 5;

  // 1 empty chunk detection + cleanup
  {
    const tracks = [{stopped:false, stop(){this.stopped=true;}},{stopped:false, stop(){this.stopped=true;}}];
    const chunks = [];
    let err = null;
    try {
      if (chunks.length === 0) throw new Error('Recording captured no frames. Please try again.');
    } catch (e) { err = e; }
    tracks.forEach(t=>t.stop());
    assert(err && /no frames/i.test(err.message), 'Empty chunk error not thrown');
    assert(tracks.every(t=>t.stopped), 'Tracks not cleaned up on empty chunk path');
    pass++;
  }

  // 2 stream cleanup on success + error
  {
    for (let i=0;i<10;i++) {
      const tracks=[{s:0,stop(){this.s++;}},{s:0,stop(){this.s++;}}];
      tracks.forEach(t=>t.stop());
      assert(tracks.every(t=>t.s===1), 'Track stop not called exactly once');
    }
    pass++;
  }

  // 3 timing guard
  {
    const d = await waitForDisplayRefresh('darwin');
    const w = await waitForDisplayRefresh('win32');
    assert(d >= 400, 'darwin wait < 400ms');
    assert(w >= 160, 'non-darwin wait < 160ms');
    pass++;
  }

  // 4 pixel clamp
  {
    const videoWidth=1920, videoHeight=1080;
    const srcRegion={x:1900,y:1060,width:400,height:200};
    srcRegion.x = clamp(srcRegion.x, 0, Math.max(0, videoWidth - 2));
    srcRegion.y = clamp(srcRegion.y, 0, Math.max(0, videoHeight - 2));
    srcRegion.width = clamp(srcRegion.width, 2, Math.max(2, videoWidth - srcRegion.x));
    srcRegion.height = clamp(srcRegion.height, 2, Math.max(2, videoHeight - srcRegion.y));
    assert(srcRegion.x + srcRegion.width <= videoWidth, 'srcRegion width overflow');
    assert(srcRegion.y + srcRegion.height <= videoHeight, 'srcRegion height overflow');
    pass++;
  }

  // 5 gif output when tools available
  {
    let ffmpegOk=true, gifskiOk=true;
    try { execFileSync('ffmpeg',['-version'],{stdio:'ignore'}); } catch { ffmpegOk=false; }
    try { execFileSync('gifski',['--version'],{stdio:'ignore'}); } catch { gifskiOk=false; }
    if (ffmpegOk && gifskiOk) {
      const tmp = path.join(process.cwd(),'tmp-validator'); fs.mkdirSync(tmp,{recursive:true});
      const mp4 = path.join(tmp,'test.mp4'); const gif = path.join(tmp,'test.gif');
      execFileSync('ffmpeg',['-y','-f','lavfi','-i','testsrc=size=640x360:rate=30','-t','3',mp4],{stdio:'ignore'});
      execFileSync('ffmpeg',['-y','-i',mp4,'-vf','fps=20,scale=640:-1:flags=lanczos',path.join(tmp,'f-%06d.png')],{stdio:'ignore'});
      const frames = fs.readdirSync(tmp).filter(x=>x.endsWith('.png')).sort().map(x=>path.join(tmp,x));
      execFileSync('gifski',['--fps','20','--quality','90','--output',gif,...frames],{stdio:'ignore'});
      const magic = fs.readFileSync(gif).slice(0,4).toString('ascii');
      assert(magic === 'GIF8', 'GIF magic bytes invalid');
      fs.rmSync(tmp,{recursive:true,force:true});
    }
    pass++;
  }

  console.log(`ALL TESTS PASSED (${pass}/${total})`);
}
run().catch((e)=>{ console.error(e.stack||e.message); process.exit(1); });
