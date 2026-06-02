const { build } = require('../package.json');

const legacyMacBuild = {
  ...build,
  artifactName: 'orange-fuji-legacy.${ext}',
  electronVersion: '22.3.27',
  mac: {
    ...build.mac,
    minimumSystemVersion: '10.13.0',
    target: [
      {
        target: 'dmg',
        arch: ['x64'],
      },
    ],
  },
};

module.exports = legacyMacBuild;
