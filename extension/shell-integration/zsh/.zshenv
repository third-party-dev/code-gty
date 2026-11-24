# code-gty: ZDOTDIR points here so zsh loads these files; each one sources the
# user's own file of the same name and then hands back control.
__gty_zdotdir=$ZDOTDIR
if [[ -n "${GTY_USER_ZDOTDIR:-}" ]]; then ZDOTDIR=$GTY_USER_ZDOTDIR; else ZDOTDIR=$HOME; fi
[[ -r "$ZDOTDIR/.zshenv" ]] && . "$ZDOTDIR/.zshenv"
# The user's .zshenv may set ZDOTDIR itself; remember it for the other files.
GTY_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__gty_zdotdir
