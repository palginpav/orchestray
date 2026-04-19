#!/usr/bin/env bash
# claude-mock-oversize.sh — mock claude that outputs more than max_output_bytes.
# Outputs 2000 bytes of 'x' chars — exceeds the minimum max_output_bytes (1024).
# The test must set max_output_bytes to the minimum (1024) to trigger oversize detection.

# Output 2000 'x' chars followed by newline
python3 -c "import sys; sys.stdout.write('x' * 2000 + '\n'); sys.stdout.flush()" 2>/dev/null \
  || node -e "process.stdout.write('x'.repeat(2000) + '\n')" 2>/dev/null \
  || awk 'BEGIN{for(i=0;i<2000;i++)printf "x";printf "\n"}'
