const { execFile } = require('child_process');
const path = require('path');

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

module.exports = async function signMacAdHoc(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appInfo = context.packager.appInfo;
  const appPath = path.join(context.appOutDir, `${appInfo.productFilename}.app`);
  await run('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--identifier',
    appInfo.id,
    appPath,
  ]);
};
