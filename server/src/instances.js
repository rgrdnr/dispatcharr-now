/**
 * Persists the list of configured Dispatcharr instances to a small JSON
 * file. There's no real concurrency to worry about here — this is a
 * single-process app talking to a handful of rows — so plain
 * readFileSync/writeFileSync is enough, no DB needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../data');
const FILE = path.join(DATA_DIR, 'instances.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(instances) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(instances, null, 2));
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function exists() {
  return fs.existsSync(FILE);
}

export function list() {
  return readAll();
}

export function add({ name, url, username, password }) {
  const instances = readAll();
  const instance = {
    id: crypto.randomUUID().slice(0, 8),
    name: name?.trim() || hostnameOf(url),
    url: String(url).replace(/\/+$/, ''),
    username,
    password,
  };
  instances.push(instance);
  writeAll(instances);
  return instance;
}

export function update(id, patch) {
  const instances = readAll();
  const i = instances.findIndex((x) => x.id === id);
  if (i === -1) return null;
  const next = { ...instances[i] };
  if (patch.name !== undefined) next.name = patch.name.trim() || next.name;
  if (patch.url !== undefined) next.url = String(patch.url).replace(/\/+$/, '');
  if (patch.username !== undefined) next.username = patch.username;
  if (patch.password) next.password = patch.password; // blank/omitted = keep existing
  instances[i] = next;
  writeAll(instances);
  return next;
}

export function remove(id) {
  const instances = readAll();
  const next = instances.filter((x) => x.id !== id);
  writeAll(next);
  return next.length !== instances.length;
}

/** Strip credentials before anything goes back to the browser. */
export function toPublic(instance) {
  const { id, name, url, username } = instance;
  return { id, name, url, username };
}
