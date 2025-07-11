export default {
  get(): string | null {
    return Deno[Deno.internal].core.ops.op_deploy_token_get();
  },
  set(token: string) {
    Deno[Deno.internal].core.ops.op_deploy_token_set(token);
  },
  remove() {
    Deno[Deno.internal].core.ops.op_deploy_token_remove();
  },
};
