/**
 * The smallest program that depends on the config loader.
 *
 * bootRefusal.test.ts runs this in a child process with a deliberately broken
 * environment. Importing config is the whole point: the refusal is the loader's
 * own `process.exit`, and only a separate process can show that the process
 * really ends.
 */
import { config } from '../platform/config.js';

console.log(`config-ok ${config.NODE_ENV}`);
