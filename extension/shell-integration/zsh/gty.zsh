# code-gty shell integration for zsh.
if [[ -o interactive && "${GTY_SHELL_INTEGRATION:-}" == 1 && -z "${__gty_loaded:-}" ]]; then
  __gty_loaded=1
  unset GTY_SHELL_INTEGRATION
  # Non-login shells never read .zlogin, so restore ZDOTDIR here too.
  if [[ ! -o login ]]; then ZDOTDIR=$GTY_USER_ZDOTDIR; unset __gty_zdotdir GTY_USER_ZDOTDIR; fi

  __gty_in_command=0
  __gty_precmd() {
    local s=$?
    if (( __gty_in_command )); then printf '\e]133;D;%s\a' "$s"; fi
    __gty_in_command=0
    printf '\e]7;file://%s%s\a' "${HOST:-}" "${PWD// /%20}"
    if [[ $PS1 != *'133;A'* ]]; then
      PS1=$'%{\e]133;A\a%}'"$PS1"$'%{\e]133;B\a%}'
    fi
  }
  __gty_preexec() {
    __gty_in_command=1
    printf '\e]133;C\a'
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __gty_precmd
  add-zsh-hook preexec __gty_preexec
fi
