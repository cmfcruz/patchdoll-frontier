#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

int main(void) {
  struct ucred cred;
  socklen_t len = sizeof(cred);

  if (getsockopt(3, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) {
    fprintf(stderr, "getsockopt(SO_PEERCRED) failed: %s\n", strerror(errno));
    return 1;
  }

  printf("{\"pid\":%d,\"uid\":%d,\"gid\":%d}\n", cred.pid, cred.uid, cred.gid);
  return 0;
}
