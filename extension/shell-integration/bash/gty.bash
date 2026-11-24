# code-gty shell integration for bash. Loaded with --init-file, so it must
# also load the files bash would normally read.
if [ -n "${__gty_loaded:-}" ]; then return; fi
__gty_loaded=1

if [ -n "${GTY_BASH_LOGIN:-}" ]; then
  unset GTY_BASH_LOGIN
  [ -r /etc/profile ] && . /etc/profile
  for __gty_f in ~/.bash_profile ~/.bash_login ~/.profile; do
    if [ -r "$__gty_f" ]; then . "$__gty_f"; break; fi
  done
  unset __gty_f
else
  [ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
  [ -r ~/.bashrc ] && . ~/.bashrc
fi

case $- in *i*) ;; *) return ;; esac
if [ "${GTY_SHELL_INTEGRATION:-}" != 1 ]; then return; fi
unset GTY_SHELL_INTEGRATION

__gty_urlencode() {
  local s=$1 out='' c i
  for (( i = 0; i < ${#s}; i++ )); do
    c=${s:i:1}
    case $c in
      [a-zA-Z0-9/._~-]) out+=$c ;;
      *) printf -v c '%%%02X' "'$c"; out+=$c ;;
    esac
  done
  printf '%s' "$out"
}

__gty_in_command=0
__gty_at_prompt=0

__gty_precmd() {
  local status=$?
  if [ "$__gty_in_command" = 1 ]; then
    printf '\e]133;D;%s\a' "$status"
  fi
  __gty_in_command=0
  printf '\e]7;file://%s%s\a' "${HOSTNAME:-}" "$(__gty_urlencode "$PWD")"
  return $status
}

__gty_precmd_end() {
  local status=$?
  # Prompt tools may rebuild PS1 every time, so re-wrap when needed.
  case $PS1 in
    *'133;A'*) ;;
    *) PS1="\[\e]133;A\a\]${PS1}\[\e]133;B\a\]" ;;
  esac
  __gty_at_prompt=1
  return $status
}

__gty_preexec() {
  [ "$__gty_at_prompt" = 1 ] || return
  [ -n "${COMP_LINE:-}" ] && return
  case $BASH_COMMAND in __gty_precmd*) return ;; esac
  __gty_at_prompt=0
  __gty_in_command=1
  printf '\e]133;C\a'
}

if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__gty_precmd "${PROMPT_COMMAND[@]}" __gty_precmd_end)
else
  PROMPT_COMMAND="__gty_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __gty_precmd_end"
fi

if declare -F __bp_install >/dev/null 2>&1 || [ -n "${bash_preexec_imported:-}" ]; then
  # bash-preexec owns the DEBUG trap; join it instead of replacing it.
  preexec_functions+=(__gty_bp_preexec)
  __gty_bp_preexec() { __gty_at_prompt=0; __gty_in_command=1; printf '\e]133;C\a'; }
elif [ -z "$(trap -p DEBUG)" ]; then
  trap '__gty_preexec' DEBUG
fi
