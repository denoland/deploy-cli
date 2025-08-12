let cachedToken: string | null = null;
let cannotInteractWithKeychain = false;

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
          console.log("Unable to interact with keychain.");
        }
        return null;
      }
    }
  },
  set(token: string) {
    cachedToken = token;
    try {
      // @ts-ignore deno internals
      Deno[Deno.internal].core.ops.op_deploy_token_set(token);
    } catch {
      if (!cannotInteractWithKeychain) {
        cannotInteractWithKeychain = true;
        console.log("Unable to interact with keychain.");
      }
    }
  },
  remove() {
    cachedToken = null;
    try {
      // @ts-ignore deno internals
      Deno[Deno.internal].core.ops.op_deploy_token_delete();
    } catch {
      if (!cannotInteractWithKeychain) {
        cannotInteractWithKeychain = true;
        console.log("Unable to interact with keychain.");
      }
    }
  },
};
