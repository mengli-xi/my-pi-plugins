#!/bin/zsh -f

# Capture the earliest practical boundary after the user's shell resolves `pi`.
# zsh/datetime is built in, so this adds no helper process before the real Bun
# binary. PI_PERF_REAL_PI is an explicit escape hatch for alternate installs.
zmodload zsh/datetime
pi_perf_epoch=${EPOCHREALTIME}
pi_perf_epoch_seconds=${pi_perf_epoch%%.*}
pi_perf_epoch_fraction=${pi_perf_epoch#*.}
export PI_PERF_LAUNCH_EPOCH_US="${pi_perf_epoch_seconds}${pi_perf_epoch_fraction[1,6]}"

pi_perf_launcher_dir=${0:A:h}
pi_perf_real_binary=${PI_PERF_REAL_PI:-${pi_perf_launcher_dir}/pi-binary}

if [[ ! -x ${pi_perf_real_binary} ]]; then
  print -u2 -- "pi launcher: executable not found: ${pi_perf_real_binary}"
  exit 127
fi

exec ${pi_perf_real_binary} "$@"
