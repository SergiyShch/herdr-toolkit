# herdr-toolkit: environment for a terminal from the Herdr space it opens in.
# scripts/install.sh copies this to ~/.config/herdr-app/toolkit-space-env.zsh;
# source it from ~/.zshrc (at the end, after PATH is set):
#
#   [[ -r ~/.config/herdr-app/toolkit-space-env.zsh ]] && source ~/.config/herdr-app/toolkit-space-env.zsh
#
# A space linked to a gcloud configuration (gcloud.spaces in toolkit.json, set
# from the tab bar's gcloud chip) gets CLOUDSDK_ACTIVE_CONFIG_NAME, so gcloud,
# and every agent started in this terminal, uses that configuration. Read once,
# when the shell starts: a new link reaches new terminals only. Outside Herdr,
# or without hc or jq, it does nothing. Costs about 10 ms.
if [[ -n ${HC_TERMINAL_ID:-} ]] && (( $+commands[hc] && $+commands[jq] )); then
  () {
    local file=${HERDR_APP_HOME:-$HOME/.config/herdr-app}/toolkit.json space config
    [[ -r $file ]] || return 0
    space=$(hc get --json "$HC_TERMINAL_ID" 2>/dev/null | jq -r '.labels["herdr.space"] // empty' 2>/dev/null)
    [[ -n $space ]] || return 0
    config=$(jq -r --arg s "$space" '.gcloud.spaces[$s] // empty' "$file" 2>/dev/null)
    [[ -n $config ]] && export CLOUDSDK_ACTIVE_CONFIG_NAME=$config
    return 0
  }
fi
