import type { Argument, Command, Example, Option } from "@cliffy/command";
import { VERSION } from "./version.ts";

// Cliffy's own introspection getters return `Command<any>`; mirror that here.
// deno-lint-ignore no-explicit-any
type AnyCommand = Command<any>;

export interface ArgumentNode {
  name: string;
  type: string;
  optional: boolean;
  variadic: boolean;
}

export interface OptionNode {
  name: string;
  flags: string[];
  description: string;
  args: ArgumentNode[];
  required: boolean;
  collect: boolean;
  global: boolean;
  hidden: boolean;
  default?: unknown;
}

export interface CommandNode {
  name: string;
  path: string;
  description: string;
  aliases: string[];
  hidden: boolean;
  arguments: ArgumentNode[];
  options: OptionNode[];
  examples: Example[];
  commands: CommandNode[];
}

export interface HelpJson extends CommandNode {
  version: string;
}

function describeArgument(arg: Argument): ArgumentNode {
  return {
    name: arg.name,
    type: arg.type,
    optional: arg.optional ?? false,
    variadic: arg.variadic ?? false,
  };
}

function describeOption(option: Option): OptionNode {
  const node: OptionNode = {
    name: option.name,
    flags: option.flags,
    description: option.description.trim(),
    args: option.args.map(describeArgument),
    required: option.required ?? false,
    collect: option.collect ?? false,
    global: option.global ?? false,
    hidden: option.hidden ?? false,
  };
  // Lazy defaults are callbacks; only static values survive serialization.
  if (option.default !== undefined && typeof option.default !== "function") {
    node.default = option.default;
  }
  return node;
}

/**
 * Serializes a command and its subtree. Hidden commands and options are
 * included (flagged `hidden: true`) so an agent sees the whole surface.
 */
export function describeCommand(
  command: AnyCommand,
  hidden = false,
): CommandNode {
  // Cliffy exposes no `isHidden()` getter; a hidden child is one that only
  // shows up in the `getCommands(true)` listing.
  const visible = new Set(
    command.getCommands(false).map((cmd: AnyCommand) => cmd.getName()),
  );
  return {
    name: command.getName(),
    path: command.getPath(),
    description: command.getDescription().trim(),
    aliases: command.getAliases(),
    hidden,
    arguments: command.getArguments().map(describeArgument),
    options: command.getOptions(true).map(describeOption),
    examples: command.getExamples(),
    commands: command.getCommands(true).map((cmd: AnyCommand) =>
      describeCommand(cmd, !visible.has(cmd.getName()))
    ),
  };
}

/** Resolves `env list --help-json` to the `list` command node. */
function resolveCommand(root: AnyCommand, args: string[]): AnyCommand {
  let command = root;
  for (const arg of args) {
    if (arg.startsWith("-")) break;
    const child: AnyCommand | undefined = command.getCommands(true).find((
      cmd: AnyCommand,
    ) => cmd.getName() === arg || cmd.getAliases().includes(arg));
    if (!child) break;
    command = child;
  }
  return command;
}

/**
 * Machine-readable `--help`: dumps the command tree (or the addressed subtree)
 * as a single JSON object on stdout. Handled before parsing so that required
 * options of the addressed command don't reject the call.
 */
export function helpJson(root: AnyCommand, args: string[]): HelpJson {
  return {
    version: VERSION,
    ...describeCommand(resolveCommand(root, args)),
  };
}
