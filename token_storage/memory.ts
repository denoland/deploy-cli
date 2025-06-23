import type { Authorization } from "../token_storage.ts";

let AUTH: Authorization | null;

export function get(): Promise<Authorization | null> {
  return Promise.resolve(AUTH);
}

export function store(auth: Authorization): Promise<void> {
  AUTH = auth;
  return Promise.resolve();
}

export function remove(): Promise<void> {
  AUTH = null;
  return Promise.resolve();
}
