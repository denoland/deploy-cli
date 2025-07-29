let cachedToken: string | null = null;

export default {
  get(): string | null {
    // @ts-ignore deno internals
    return cachedToken ??= Deno[Deno.internal].core.ops.op_deploy_token_get();
  },
  set(token: string) {
    // @ts-ignore deno internals
    Deno[Deno.internal].core.ops.op_deploy_token_set(token);
    cachedToken = token;
  },
  remove() {
    // @ts-ignore deno internals
    Deno[Deno.internal].core.ops.op_deploy_token_delete();
    cachedToken = null;
  },
};
