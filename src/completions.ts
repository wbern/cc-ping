const COMMANDS =
  "ping scan add remove list status next-reset history suggest check completions moo daemon";

function bashCompletion(): string {
  return `_cc_ping() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${COMMANDS}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
    ping)
      if [[ "\${cur}" == -* ]]; then
        COMPREPLY=( $(compgen -W "--parallel --quiet --json --group --bell --notify --stagger" -- "\${cur}") )
      else
        local handles=$(cc-ping list 2>/dev/null | sed 's/ *\\(.*\\) ->.*/\\1/')
        COMPREPLY=( $(compgen -W "\${handles}" -- "\${cur}") )
      fi
      ;;
    add)
      COMPREPLY=( $(compgen -W "--name --group" -- "\${cur}") )
      ;;
    list|history|status|next-reset|check)
      COMPREPLY=( $(compgen -W "--json" -- "\${cur}") )
      ;;
    completions)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
      ;;
    daemon)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "start stop status install uninstall" -- "\${cur}") )
      elif [[ "\${COMP_WORDS[2]}" == "start" && "\${cur}" == -* ]]; then
        COMPREPLY=( $(compgen -W "--interval --quiet --bell --notify" -- "\${cur}") )
      elif [[ "\${COMP_WORDS[2]}" == "install" && "\${cur}" == -* ]]; then
        COMPREPLY=( $(compgen -W "--interval --quiet --bell --notify" -- "\${cur}") )
      elif [[ "\${COMP_WORDS[2]}" == "status" && "\${cur}" == -* ]]; then
        COMPREPLY=( $(compgen -W "--json" -- "\${cur}") )
      fi
      ;;
  esac
  return 0
}
complete -F _cc_ping cc-ping
`;
}

function zshCompletion(): string {
  return `#compdef cc-ping

_cc_ping() {
  local -a commands
  commands=(
    'ping:Ping configured accounts'
    'scan:Auto-discover accounts'
    'add:Add an account manually'
    'remove:Remove an account'
    'list:List configured accounts'
    'status:Show account status'
    'next-reset:Show soonest quota reset'
    'history:Show ping history'
    'suggest:Suggest next account'
    'check:Verify account health'
    'completions:Generate shell completions'
    'moo:Send a test notification'
    'daemon:Run auto-ping on a schedule'
  )

  _arguments -C \\
    '--config[Config directory]:path:_files -/' \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        ping)
          _arguments \\
            '--parallel[Ping in parallel]' \\
            '--quiet[Suppress output]' \\
            '--json[JSON output]' \\
            '--group[Filter by group]:group:' \\
            '--bell[Ring bell on failure]' \\
            '--notify[Send notification on new windows and failures]' \\
            '--stagger[Delay between pings]:minutes:' \\
            '*:handle:->handles'
          if [[ $state == handles ]]; then
            local -a handles
            handles=(\${(f)"$(cc-ping list 2>/dev/null | sed 's/ *\\(.*\\) ->.*/\\1/')"})
            _describe 'handle' handles
          fi
          ;;
        completions)
          _arguments '1:shell:(bash zsh fish)'
          ;;
        list|history|status|next-reset|check)
          _arguments '--json[JSON output]'
          ;;
        add)
          _arguments \
            '--name[Override handle]:name:' \
            '--group[Assign group]:group:'
          ;;
        daemon)
          local -a subcmds
          subcmds=(
            'start:Start the daemon process'
            'stop:Stop the daemon process'
            'status:Show daemon status'
            'install:Install as system service'
            'uninstall:Remove system service'
          )
          _arguments '1:subcommand:->subcmd' '*::arg:->subargs'
          case $state in
            subcmd)
              _describe 'subcommand' subcmds
              ;;
            subargs)
              case $words[1] in
                start|install)
                  _arguments \\
                    '--interval[Ping interval in minutes]:minutes:' \\
                    '--quiet[Suppress ping output]' \\
                    '--bell[Ring bell on failure]' \\
                    '--notify[Send notification on new windows and failures]'
                  ;;
                status)
                  _arguments '--json[JSON output]'
                  ;;
              esac
              ;;
          esac
          ;;
      esac
      ;;
  esac
}

_cc_ping
`;
}

function fishCompletion(): string {
  return `# Fish completions for cc-ping
set -l commands ping scan add remove list status next-reset history suggest check completions moo

complete -c cc-ping -f
complete -c cc-ping -n "not __fish_seen_subcommand_from $commands" -a ping -d "Ping configured accounts"
complete -c cc-ping -n "not __fish_seen_subcommand_from $commands" -a scan -d "Auto-discover accounts"
complete -c cc-ping -n "not __fish_seen_subcommand_from $commands" -a add -d "Add an account manually"
complete -c cc-ping -n "not __fish_seen_subcommand_from $commands" -a remove -d "Remove an account"
complete -c cc-ping -n "not __fish_seen_subcommand_from $commands" -a list -d "List configured accounts"
complete -c cc-ping -n "not __fish_seen_subcommand_from $commands" -a status -d "Show account status"
complete -c cc-ping -n "not __fish_seen_subcommand_from $commands" -a next-reset -d "Show soonest quota reset"
complete -c cc-ping -n "not __fish_seen_subcommand_from $commands" -a history -d "Show ping history"
complete -c cc-ping -n "not __fish_seen_subcommand_from $commands" -a suggest -d "Suggest next account"
complete -c cc-ping -n "not __fish_seen_subcommand_from $commands" -a check -d "Verify account health"
complete -c cc-ping -n "not __fish_seen_subcommand_from $commands" -a completions -d "Generate shell completions"
complete -c cc-ping -n "not __fish_seen_subcommand_from $commands" -a moo -d "Send a test notification"
complete -c cc-ping -n "not __fish_seen_subcommand_from $commands" -a daemon -d "Run auto-ping on a schedule"

complete -c cc-ping -n "__fish_seen_subcommand_from ping" -l parallel -d "Ping in parallel"
complete -c cc-ping -n "__fish_seen_subcommand_from ping" -s q -l quiet -d "Suppress output"
complete -c cc-ping -n "__fish_seen_subcommand_from ping" -l json -d "JSON output"
complete -c cc-ping -n "__fish_seen_subcommand_from ping" -s g -l group -r -d "Filter by group"
complete -c cc-ping -n "__fish_seen_subcommand_from ping" -l bell -d "Ring bell on failure"
complete -c cc-ping -n "__fish_seen_subcommand_from ping" -l notify -d "Send notification on new windows and failures"
complete -c cc-ping -n "__fish_seen_subcommand_from ping" -l stagger -r -d "Delay between pings"
complete -c cc-ping -n "__fish_seen_subcommand_from ping" -a "(cc-ping list 2>/dev/null | string replace -r ' *(.*) ->.*' '$1')"

complete -c cc-ping -n "__fish_seen_subcommand_from list history status next-reset check" -l json -d "JSON output"
complete -c cc-ping -n "__fish_seen_subcommand_from add" -s n -l name -r -d "Override handle"
complete -c cc-ping -n "__fish_seen_subcommand_from add" -s g -l group -r -d "Assign group"
complete -c cc-ping -n "__fish_seen_subcommand_from completions" -a "bash zsh fish"

complete -c cc-ping -n "__fish_seen_subcommand_from daemon; and not __fish_seen_subcommand_from start stop status install uninstall" -a start -d "Start the daemon"
complete -c cc-ping -n "__fish_seen_subcommand_from daemon; and not __fish_seen_subcommand_from start stop status install uninstall" -a stop -d "Stop the daemon"
complete -c cc-ping -n "__fish_seen_subcommand_from daemon; and not __fish_seen_subcommand_from start stop status install uninstall" -a status -d "Show daemon status"
complete -c cc-ping -n "__fish_seen_subcommand_from daemon; and not __fish_seen_subcommand_from start stop status install uninstall" -a install -d "Install as system service"
complete -c cc-ping -n "__fish_seen_subcommand_from daemon; and not __fish_seen_subcommand_from start stop status install uninstall" -a uninstall -d "Remove system service"
complete -c cc-ping -n "__fish_seen_subcommand_from daemon; and __fish_seen_subcommand_from start install" -l interval -r -d "Ping interval in minutes"
complete -c cc-ping -n "__fish_seen_subcommand_from daemon; and __fish_seen_subcommand_from start install" -s q -l quiet -d "Suppress output"
complete -c cc-ping -n "__fish_seen_subcommand_from daemon; and __fish_seen_subcommand_from start install" -l bell -d "Ring bell on failure"
complete -c cc-ping -n "__fish_seen_subcommand_from daemon; and __fish_seen_subcommand_from start install" -l notify -d "Send notification on new windows and failures"
complete -c cc-ping -n "__fish_seen_subcommand_from daemon; and __fish_seen_subcommand_from status" -l json -d "JSON output"
`;
}

export function generateCompletion(shell: string): string {
  switch (shell) {
    case "bash":
      return bashCompletion();
    case "zsh":
      return zshCompletion();
    case "fish":
      return fishCompletion();
    default:
      throw new Error(
        `Unsupported shell: ${shell}. Supported: bash, zsh, fish`,
      );
  }
}
