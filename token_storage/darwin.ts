import keychain from "npm:keychain@1.5.0";
import type { Authorization } from "../token_storage.ts";

const KEYCHAIN_TOKEN_CREDS = {
  account: "Deno Deploy",
  service: "Deno Deploy Token",
};
const KEYCHAIN_GITHUB_USER_CREDS = {
  account: "Deno Deploy",
  service: "Deno Deploy GitHub User",
};

export async function getFromKeychain(): Promise<Authorization | null> {
  const [token, githubUser] = await Promise.all([
    new Promise<string | null>((resolve, reject) =>
      keychain.getPassword(
        KEYCHAIN_TOKEN_CREDS,
        (err: KeychainError, token: string | null) => {
          if (err && err.code !== "PasswordNotFound") {
            reject(err);
          } else {
            resolve(token);
          }
        },
      )
    ),
    new Promise<string | null>((resolve, reject) =>
      keychain.getPassword(
        KEYCHAIN_GITHUB_USER_CREDS,
        (err: KeychainError, user: string | null) => {
          if (err && err.code !== "PasswordNotFound") {
            reject(err);
          } else {
            resolve(user);
          }
        },
      )
    ),
  ]);

  if (!token || !githubUser) {
    return null;
  }

  return {
    token,
    githubUser,
  };
}

export async function storeInKeyChain(auth: Authorization): Promise<void> {
  await Promise.all([
    new Promise<void>((resolve, reject) =>
      keychain.setPassword(
        { ...KEYCHAIN_TOKEN_CREDS, password: auth.token },
        (err: KeychainError) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
      )
    ),
    new Promise<void>((resolve, reject) =>
      keychain.setPassword(
        { ...KEYCHAIN_GITHUB_USER_CREDS, password: auth.githubUser },
        (err: KeychainError) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
      )
    ),
  ]);
}

export async function removeFromKeyChain(): Promise<void> {
  await Promise.all([
    new Promise<void>((resolve, reject) =>
      keychain.deletePassword(KEYCHAIN_TOKEN_CREDS, (err: KeychainError) => {
        if (err && err.code !== "PasswordNotFound") {
          reject(err);
        } else {
          resolve();
        }
      })
    ),
    new Promise<void>((resolve, reject) =>
      keychain.deletePassword(
        KEYCHAIN_GITHUB_USER_CREDS,
        (err: KeychainError) => {
          if (err && err.code !== "PasswordNotFound") {
            reject(err);
          } else {
            resolve();
          }
        },
      )
    ),
  ]);
}

interface KeychainError {
  code: string;
}
