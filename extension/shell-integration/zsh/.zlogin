ZDOTDIR=$GTY_USER_ZDOTDIR
[[ -r "$ZDOTDIR/.zlogin" ]] && . "$ZDOTDIR/.zlogin"
# Done with startup files: restore the user's ZDOTDIR for good.
unset __gty_zdotdir GTY_USER_ZDOTDIR
