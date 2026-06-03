const fs = require('fs');
const path = require('path');

const target = (process.env.ORANGE_FUJI_LICENSE_TARGET || 'pre').trim().toLowerCase();

const defaults = {
  pre: {
    buyLicenseUrl: 'https://buy.stripe.com/test_00w00ka8w3Us4cb5z6bQY00',
    licenseApiBaseUrl: 'https://xnppcugncigaiycrvmpk.supabase.co/functions/v1',
    supabasePublishableKey: 'sb_publishable_UF9_SxKlinhz2n0mPIYXGw_92sei9VY',
  },
  pro: {
    buyLicenseUrl: 'https://buy.stripe.com/00w00ka8w3Us4cb5z6bQY00',
    licenseApiBaseUrl: 'https://lfckwzwhaqujmibicxeg.supabase.co/functions/v1',
    supabasePublishableKey: 'sb_publishable_R8GxNds436XaSRVhHfxOsA_vVe0cEwA',
  },
};

const envPrefix = `ORANGE_FUJI_${target.toUpperCase()}`;
const config = {
  buyLicenseUrl: process.env[`${envPrefix}_BUY_LICENSE_URL`] || defaults[target]?.buyLicenseUrl || '',
  licenseApiBaseUrl: process.env[`${envPrefix}_LICENSE_API_BASE_URL`] || defaults[target]?.licenseApiBaseUrl || '',
  supabasePublishableKey: process.env[`${envPrefix}_SUPABASE_PUBLISHABLE_KEY`] || defaults[target]?.supabasePublishableKey || '',
};

for (const [key, value] of Object.entries(config)) {
  if (!value) {
    throw new Error(`Missing ${key} for ${target}. Set ${envPrefix}_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}.`);
  }
}

const outputPath = path.join(__dirname, '..', 'src', 'license-config.js');
const output = `module.exports = ${JSON.stringify(config, null, 2)};\n`;

fs.writeFileSync(outputPath, output);
console.log(`Configured Orange Fuji ${target.toUpperCase()} license endpoint: ${config.licenseApiBaseUrl}`);
