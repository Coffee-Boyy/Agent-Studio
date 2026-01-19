CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -Werror
LDFLAGS ?= -lseccomp

all: codex-linux-sandbox

codex-linux-sandbox: codex-linux-sandbox.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f codex-linux-sandbox
