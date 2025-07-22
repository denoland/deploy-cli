export default {
  get(): string | null {
    // @ts-ignore deno internals
    return Deno[Deno.internal].core.ops.op_deploy_token_get();
  },
  set(token: string) {
    // @ts-ignore deno internals
    Deno[Deno.internal].core.ops.op_deploy_token_set(token);
  },
  remove() {
    // @ts-ignore deno internals
    Deno[Deno.internal].core.ops.op_deploy_token_delete();
  },
};
