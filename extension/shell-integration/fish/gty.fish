# code-gty shell integration for fish (loaded with --init-command, which runs
# after config.fish).
if status is-interactive; and test "$GTY_SHELL_INTEGRATION" = 1; and not set -q __gty_loaded
    set -g __gty_loaded 1
    set -e GTY_SHELL_INTEGRATION

    function __gty_preexec --on-event fish_preexec
        set -g __gty_in_command 1
        printf '\e]133;C\a'
    end

    function __gty_postexec --on-event fish_postexec
        printf '\e]133;D;%s\a' $status
        set -g __gty_in_command 0
    end

    function __gty_cwd --on-variable PWD
        printf '\e]7;file://%s%s\a' (hostname) (string escape --style=url -- $PWD | string replace -a '%2F' '/')
    end
    __gty_cwd

    functions -c fish_prompt __gty_user_prompt
    function fish_prompt
        printf '\e]133;A\a'
        __gty_user_prompt
        printf '\e]133;B\a'
    end
end
