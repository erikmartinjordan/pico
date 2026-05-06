#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const artifactsDir = path.join(repoRoot, '.pico-agent');
const logPath = path.join(artifactsDir, 'capture-e2e-failure.log');
const wantsFix = process.argv.includes('--fix');

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      shell: options.shell || false,
      stdio: options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const capture = (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    };
    const captureErr = (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    };

    child.stdout.on('data', capture);
    child.stderr.on('data', captureErr);
    if (options.input) child.stdin.end(options.input);
    child.on('close', (code) => resolve({ code, output }));
  });
}


function commandExists(command) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    shell: process.platform !== 'win32',
    stdio: 'ignore',
  });
  return probe.status === 0;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildPrompt(logExcerpt) {
  return [
    'You are working in the pico Electron app repository.',
    'The automated capture E2E suite failed. Fix the application or tests so these flows pass:',
    '- rectangle/region capture',
    '- window capture',
    '- fullscreen capture',
    '- MP4 recording export',
    '- GIF recording export',
    '',
    'Constraints:',
    '- Preserve production behavior; keep any test-only bypasses behind PICO_E2E.',
    '- Run npm run test:capture after changes and iterate until it passes.',
    '- Commit the fix on the current branch when complete.',
    '',
    `Failure log (${logPath}):`,
    logExcerpt,
  ].join('\n');
}

function resolveAgentCommand(prompt) {
  if (process.env.PICO_FIX_AGENT_COMMAND) {
    return {
      command: process.env.PICO_FIX_AGENT_COMMAND,
      args: [],
      shell: true,
      input: prompt,
      label: 'PICO_FIX_AGENT_COMMAND',
    };
  }

  if (commandExists('codex')) {
    return {
      command: 'codex',
      args: ['exec', prompt],
      shell: false,
      input: null,
      label: 'codex exec',
    };
  }

  return null;
}

async function main() {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const firstRun = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'test:capture']);
  if (firstRun.code === 0) {
    console.log('\nCapture E2E suite passed. No agent fix needed.');
    return;
  }

  fs.writeFileSync(logPath, firstRun.output);
  console.error(`\nCapture E2E suite failed. Log written to ${logPath}.`);

  if (!wantsFix) {
    console.error('Run npm run test:capture:agent to invoke a fixing agent automatically.');
    process.exit(firstRun.code || 1);
  }

  const excerpt = firstRun.output.slice(-20_000);
  const prompt = buildPrompt(excerpt);
  const agent = resolveAgentCommand(prompt);
  if (!agent) {
    console.error('No fixing agent command was found. Install the Codex CLI as `codex` or set PICO_FIX_AGENT_COMMAND.');
    process.exit(firstRun.code || 1);
  }

  console.log(`\nInvoking fixing agent via ${agent.label}...`);
  if (agent.shell && process.env.PICO_FIX_AGENT_COMMAND) {
    console.log(`Command: ${process.env.PICO_FIX_AGENT_COMMAND}`);
  } else if (!agent.shell) {
    console.log(`Command: ${agent.command} ${agent.args.map(shellQuote).join(' ')}`);
  }

  const fixRun = await run(agent.command, agent.args, { shell: agent.shell, input: agent.input });
  if (fixRun.code !== 0) {
    console.error('\nThe fixing agent exited with an error. Inspect its output above.');
    process.exit(fixRun.code || 1);
  }

  console.log('\nRe-running capture E2E suite after agent changes...');
  const secondRun = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'test:capture']);
  if (secondRun.code !== 0) {
    fs.writeFileSync(logPath, secondRun.output);
    console.error(`\nCapture E2E suite still fails. Updated log written to ${logPath}.`);
    process.exit(secondRun.code || 1);
  }

  console.log('\nCapture E2E suite passed after agent changes.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
