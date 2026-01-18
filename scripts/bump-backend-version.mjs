import { execSync } from 'node:child_process';

function usage() {
  // eslint-disable-next-line no-console
  console.log(`Deprecated:
  Use node scripts/bump-version.mjs instead (single version for all modules).`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.log('Deprecated: forwarding to bump-version.mjs');
  execSync(`node scripts/bump-version.mjs ${process.argv.slice(2).join(' ')}`.trim(), {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(String(e));
  process.exit(1);
});


