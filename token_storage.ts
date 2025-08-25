let cachedToken: string | null = null;
let tokenIsTemp = false;
let cannotInteractWithKeychain = false;

const KEYCHAIN_WARNING =
  "Unable to interact with keychain.\nThe authentication will not be stored and will only work on this execution.";

export default {
  get(): string | null {
    if (cachedToken) {
      return cachedToken;
    } else {
      try {
        // @ts-ignore deno internals
        return Deno[Deno.internal].core.ops.op_deploy_token_get();
      } catch {
        if (!cannotInteractWithKeychain) {
          cannotInteractWithKeychain = true;
          console.log(KEYCHAIN_WARNING);
        }
        return null;
      }
    }
  },
  set(token: string, temp: boolean = false) {
    cachedToken = token;
    if (!temp) {
      try {
        // @ts-ignore deno internals
        Deno[Deno.internal].core.ops.op_deploy_token_set(token);
      } catch {
        if (!cannotInteractWithKeychain) {
          cannotInteractWithKeychain = true;
          console.log(KEYCHAIN_WARNING);
        }
      }
    } else {
      tokenIsTemp = temp;
    }
  },
  remove() {
    if (tokenIsTemp) {
      return;
    }
    cachedToken = null;
    try {
      // @ts-ignore deno internals
      Deno[Deno.internal].core.ops.op_deploy_token_delete();
    } catch {
      if (!cannotInteractWithKeychain) {
        cannotInteractWithKeychain = true;
        console.log(KEYCHAIN_WARNING);
      }
    }
  },
};
