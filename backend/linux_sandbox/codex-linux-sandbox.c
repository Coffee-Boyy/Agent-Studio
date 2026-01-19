#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <seccomp.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

static int landlock_create_ruleset(struct landlock_ruleset_attr *attr, size_t size, __u32 flags) {
  return syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int landlock_add_rule(int ruleset_fd, enum landlock_rule_type type,
                             const void *attr, __u32 flags) {
  return syscall(__NR_landlock_add_rule, ruleset_fd, type, attr, flags);
}

static int landlock_restrict_self(int ruleset_fd, __u32 flags) {
  return syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}

static bool allow_no_sandbox(void) {
  const char *val = getenv("AGENT_STUDIO_UNSAFE_ALLOW_NO_SANDBOX");
  return val && strcmp(val, "1") == 0;
}

static void usage(void) {
  fprintf(stderr, "Usage: codex-linux-sandbox --mode <mode> --workspace <path> -- <cmd> [args...]\n");
}

static int add_path_rule(int ruleset_fd, const char *path, __u64 access) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    return -1;
  }
  struct landlock_path_beneath_attr attr = {
      .allowed_access = access,
      .parent_fd = fd,
  };
  int rc = landlock_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &attr, 0);
  close(fd);
  return rc;
}

static int apply_landlock(const char *workspace, const char *mode) {
  __u64 read_access = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |
                      LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_READ_DIR |
                      LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
  __u64 write_access = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
                       LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |
                       LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
                       LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
                       LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM;

  struct landlock_ruleset_attr ruleset_attr = {
      .handled_access_fs = read_access | write_access,
  };

  int ruleset_fd = landlock_create_ruleset(&ruleset_attr, sizeof(ruleset_attr), 0);
  if (ruleset_fd < 0) {
    return -1;
  }

  __u64 workspace_access = read_access;
  if (strcmp(mode, "workspace_write") == 0 || strcmp(mode, "network_allowed") == 0) {
    workspace_access |= write_access;
  }

  if (add_path_rule(ruleset_fd, workspace, workspace_access) != 0) {
    close(ruleset_fd);
    return -1;
  }
  if (add_path_rule(ruleset_fd, "/tmp", read_access | write_access) != 0) {
    close(ruleset_fd);
    return -1;
  }
  add_path_rule(ruleset_fd, "/private/tmp", read_access | write_access);

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) {
    close(ruleset_fd);
    return -1;
  }
  if (landlock_restrict_self(ruleset_fd, 0)) {
    close(ruleset_fd);
    return -1;
  }
  close(ruleset_fd);
  return 0;
}

static int apply_seccomp(void) {
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
  if (!ctx) {
    return -1;
  }
  seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ptrace), 0);
  seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(kexec_load), 0);
  seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(kexec_file_load), 0);
  seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(reboot), 0);
  seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(mount), 0);
  seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(umount2), 0);
  seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(bpf), 0);
  int rc = seccomp_load(ctx);
  seccomp_release(ctx);
  return rc;
}

int main(int argc, char **argv) {
  const char *mode = NULL;
  const char *workspace = NULL;
  int cmd_index = -1;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--mode") == 0 && i + 1 < argc) {
      mode = argv[++i];
      continue;
    }
    if (strcmp(argv[i], "--workspace") == 0 && i + 1 < argc) {
      workspace = argv[++i];
      continue;
    }
    if (strcmp(argv[i], "--") == 0) {
      cmd_index = i + 1;
      break;
    }
  }

  if (!mode || !workspace || cmd_index < 0 || cmd_index >= argc) {
    usage();
    return 2;
  }

  if (strcmp(mode, "full_access") == 0) {
    execvp(argv[cmd_index], &argv[cmd_index]);
    perror("execvp");
    return 1;
  }

  if (apply_landlock(workspace, mode) != 0) {
    if (!allow_no_sandbox()) {
      fprintf(stderr, "Landlock unavailable or failed: %s\n", strerror(errno));
      return 1;
    }
  }

  if (apply_seccomp() != 0) {
    if (!allow_no_sandbox()) {
      fprintf(stderr, "seccomp unavailable or failed: %s\n", strerror(errno));
      return 1;
    }
  }

  execvp(argv[cmd_index], &argv[cmd_index]);
  perror("execvp");
  return 1;
}
