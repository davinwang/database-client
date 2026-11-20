#!/usr/bin/env node
import { main } from '../lib/cli.mjs';

// Exit quietly when the pipe closes early (| head) instead of dumping an EPIPE stack
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
});

const code = await main(process.argv.slice(2));
process.exitCode = code;

// Safety net: if a driver leaves a socket/timer behind, do not let the command hang forever
// (on the normal path the unref'd timer does not keep the process alive)
setTimeout(() => process.exit(code), 5000).unref();
