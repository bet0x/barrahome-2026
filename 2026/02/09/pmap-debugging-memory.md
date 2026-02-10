# pmap: debugging memory layout and understanding process address space

**Published on:** 2026/02/09

**Tags:** linux, debugging, memory, tools, c, python

When debugging memory issues—leaks, fragmentation, unusual RSS growth—the first question is often: *where is all that memory?* `pmap` provides a process-level view of memory mappings, showing not just how much memory a process uses, but *what kind* of memory and *where it's located*.

This post explains how to use `pmap` for debugging, what each field means, and demonstrates memory behavior with small C and Python scripts.

## What is pmap?

`pmap` reports the memory map of a process. It shows:

- Memory-mapped regions (code, data, heap, stack, shared libraries, anonymous mappings)
- Virtual addresses and sizes
- Permissions (read, write, execute)
- Resident Set Size (RSS) — how much physical RAM each region actually uses
- Dirty pages — modified pages not yet written to disk

Basic usage:

```bash
pmap <pid>
```

For more detail:

```bash
pmap -x <pid>   # Extended format (shows RSS, dirty pages)
pmap -X <pid>   # Even more detailed
pmap -p <pid>   # Show full path to mapped files
```

## Reading pmap output

Here's the output from `pmap -x` on a small process:

```
Address           Kbytes     RSS   Dirty Mode  Mapping
0000555555554000       4       4       0 r---- test_program
0000555555555000       4       4       0 r-x-- test_program
0000555555556000       4       4       4 r---- test_program
0000555555557000       4       4       4 rw--- test_program
00007ffff7dd0000     160     160       0 r---- libc.so.6
00007ffff7df8000    1620     832       0 r-x-- libc.so.6
00007ffff7f8d000     352      84       0 r---- libc.so.6
00007ffff7fe5000      16      16      16 rw--- libc.so.6
00007ffffffde000     132      12      12 rw---   [ stack ]
---------------- ------- ------- -------
total kB            2300    1120      36
```

**Field breakdown:**

- **Address**: virtual memory address (starting point of the region)
- **Kbytes**: size of the region in virtual memory
- **RSS**: Resident Set Size (physical RAM actually used)
- **Dirty**: pages modified in memory (not flushed to disk)
- **Mode**: permissions (`r` read, `w` write, `x` execute, `-` none)
- **Mapping**: what the region represents (executable, library, heap, stack, anonymous)

**Key insight**: `Kbytes` shows *virtual* memory (reserved address space), `RSS` shows *physical* memory (actual RAM used). A process can have gigabytes of virtual memory but only megabytes of RSS.

## Common memory regions

**Executable segments:**
```
0000555555554000  r----  # Read-only data (.rodata)
0000555555555000  r-x--  # Code (.text)
0000555555557000  rw---  # Initialized data (.data, .bss)
```

**Heap:**
```
0000555555558000  rw---  [ heap ]
```
Grows upward with `malloc()`, `new`, etc.

**Shared libraries:**
```
00007ffff7dd0000  r---- libc.so.6
00007ffff7df8000  r-x-- libc.so.6  # Library code
00007ffff7fe5000  rw--- libc.so.6  # Library globals
```

**Stack:**
```
00007ffffffde000  rw---  [ stack ]
```
Grows downward from high addresses.

**Anonymous mappings:**
```
00007ffff7fc0000  rw---  [ anon ]
```
Created with `mmap(MAP_ANONYMOUS)`. Often used for thread stacks, large allocations, or memory pools.

## Example 1: Tracking heap growth in C

Let's allocate memory in stages and watch the heap expand.

**test_heap.c:**

```c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main() {
    printf("PID: %d\n", getpid());
    printf("Press Enter to allocate 10 MB...\n");
    getchar();

    // Allocate 10 MB
    char *ptr1 = malloc(10 * 1024 * 1024);
    if (!ptr1) {
        perror("malloc");
        return 1;
    }
    printf("Allocated 10 MB. Press Enter to allocate another 50 MB...\n");
    getchar();

    // Allocate 50 MB
    char *ptr2 = malloc(50 * 1024 * 1024);
    if (!ptr2) {
        perror("malloc");
        free(ptr1);
        return 1;
    }
    printf("Allocated 50 MB more. Press Enter to write to first allocation...\n");
    getchar();

    // Touch the first allocation (causes RSS to grow)
    for (int i = 0; i < 10 * 1024 * 1024; i++) {
        ptr1[i] = 'A';
    }
    printf("Wrote to 10 MB. Press Enter to exit...\n");
    getchar();

    free(ptr1);
    free(ptr2);
    return 0;
}
```

**Compile and run:**

```bash
gcc -o test_heap test_heap.c
./test_heap
```

**In another terminal, watch the memory map:**

```bash
# Get the PID from the first terminal
watch -n 1 'pmap -x <pid> | grep -E "(heap|total)"'
```

**What you'll see:**

1. **After first allocation (10 MB):**
   ```
   [ heap ]   10240 KB virtual,   0 KB RSS
   ```
   Memory is reserved but not physically allocated (lazy allocation).

2. **After second allocation (50 MB):**
   ```
   [ heap ]   61440 KB virtual,   0 KB RSS
   ```
   Still no physical memory used.

3. **After writing to the first 10 MB:**
   ```
   [ heap ]   61440 KB virtual,   10240 KB RSS
   ```
   Now the OS maps physical pages (RSS increases).

**Key takeaway**: Virtual memory is cheap. Physical memory (RSS) is only allocated when you actually touch the pages.

## Example 2: Anonymous mappings with mmap in C

Instead of using `malloc()` (which uses the heap), we can directly request anonymous memory with `mmap()`.

**test_mmap.c:**

```c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/mman.h>
#include <string.h>

int main() {
    printf("PID: %d\n", getpid());
    printf("Press Enter to mmap 100 MB...\n");
    getchar();

    // Request 100 MB of anonymous memory
    size_t size = 100 * 1024 * 1024;
    void *ptr = mmap(NULL, size, PROT_READ | PROT_WRITE, 
                     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (ptr == MAP_FAILED) {
        perror("mmap");
        return 1;
    }

    printf("mmap'd 100 MB at %p. Press Enter to write to it...\n", ptr);
    getchar();

    // Touch every page (force physical allocation)
    memset(ptr, 0xAA, size);

    printf("Wrote to 100 MB. Press Enter to munmap...\n");
    getchar();

    munmap(ptr, size);

    printf("munmap'd. Press Enter to exit...\n");
    getchar();
    return 0;
}
```

**Compile and run:**

```bash
gcc -o test_mmap test_mmap.c
./test_mmap
```

**Check pmap:**

```bash
pmap -x <pid> | grep anon
```

**Before writing:**
```
00007f8e40000000  102400      0      0 rw---   [ anon ]
```

**After writing:**
```
00007f8e40000000  102400  102400  102400 rw---   [ anon ]
```

Notice `RSS` and `Dirty` both jump to 102400 KB — the OS allocated physical pages and they're marked dirty because we wrote to them.

**Key takeaway**: `mmap()` gives you more control over memory regions. This is how allocators (like `jemalloc`, `tcmalloc`) and memory-mapped files work.

## Example 3: Python memory behavior

Python's memory management is more opaque, but `pmap` still helps. Let's create a large list and see where the memory goes.

**test_python.py:**

```python
import os

print(f"PID: {os.getpid()}")
input("Press Enter to allocate a large list...\n")

# Allocate ~100 MB (list of integers)
data = [i for i in range(10_000_000)]

input(f"Allocated list with {len(data)} elements. Press Enter to delete...\n")

del data

input("Deleted list. Press Enter to exit...\n")
```

**Run it:**

```bash
python3 test_python.py
```

**Check pmap before allocation:**

```bash
pmap -x <pid> | grep -E "(heap|anon|total)"
```

**After allocation:**

You'll see multiple anonymous regions grow (Python uses its own allocator, which requests memory via `mmap()`):

```
00007f1e4c000000   262144   80000   80000 rw---   [ anon ]
00007f1e5c000000   131072   45000   45000 rw---   [ anon ]
```

**After deletion:**

RSS may *not* immediately drop. Python caches freed memory for future allocations. The virtual memory remains mapped.

**Key takeaway**: High-level languages like Python don't always return memory to the OS immediately. Use `pmap` to distinguish between virtual and physical memory usage.

## Debugging use case: finding memory leaks

Suppose a process gradually consumes more memory over time. Use `pmap` to identify the culprit:

```bash
# Take a snapshot every 10 seconds
while true; do 
    pmap -x <pid> | grep -E "(heap|anon|total)" >> pmap_log.txt
    echo "---" >> pmap_log.txt
    sleep 10
done
```

**Look for:**

- **Heap steadily growing** — classic malloc/free imbalance
- **Anonymous regions growing** — `mmap()` leaks or thread stacks not being released
- **Dirty pages increasing** — data being written but not freed

**Cross-reference with `valgrind` or `AddressSanitizer` to pinpoint the exact allocation.**

## Comparing pmap with /proc/PID/smaps

`pmap` is a front-end to `/proc/<pid>/maps` and `/proc/<pid>/smaps`. For even more detail:

```bash
cat /proc/<pid>/smaps
```

This shows:

- **Private_Clean** — read-only private pages (e.g., code)
- **Private_Dirty** — modified private pages (e.g., heap, stack)
- **Shared_Clean** — shared libraries (read-only)
- **Shared_Dirty** — shared libraries with COW (copy-on-write) modifications

**When to use `smaps` instead of `pmap`:**

- You need exact per-page accounting
- You're debugging shared memory or `mmap(MAP_SHARED)`
- You want to see swap usage

## Practical tips

**Identify large allocations:**

```bash
pmap -x <pid> | sort -k3 -n | tail -10
```

Sorts by RSS (column 3) — shows the top 10 memory hogs.

**Watch for fragmentation:**

If heap RSS is much smaller than heap virtual size, you may have fragmentation:

```
[ heap ]   500000 KB virtual,   120000 KB RSS
```

This often happens with long-running processes that allocate/free variable-sized chunks.

**Compare before/after:**

```bash
pmap -x <pid> > before.txt
# ... trigger memory-intensive operation ...
pmap -x <pid> > after.txt
diff before.txt after.txt
```

**Thread stacks:**

Each thread gets its own stack (usually 8 MB on Linux). With 100 threads, that's 800 MB of virtual memory:

```bash
pmap -x <pid> | grep stack | wc -l  # Count stack regions
```

If you see many small anonymous regions (~8 MB each), those are likely thread stacks.

## When pmap won't help

**Shared memory (`shmget`, `mmap(MAP_SHARED)`):**

`pmap` shows the mapping, but RSS doesn't indicate whether other processes are also using it. Use `ipcs -m` for System V shared memory.

**Memory-mapped files:**

`pmap` shows the file mapping, but not whether pages are cached by the kernel. Check `/proc/meminfo` or `vmtouch`.

**Kernel memory:**

`pmap` only sees userspace. For kernel memory (slab caches, page tables, etc.), use `slabtop` or `/proc/slabinfo`.

## Summary

`pmap` is a lightweight, always-available tool for understanding process memory:

✅ **Virtual vs. physical memory** — see what's reserved vs. what's in RAM  
✅ **Heap vs. anonymous mappings** — distinguish malloc from mmap  
✅ **Library overhead** — identify large shared libraries  
✅ **Memory leak detection** — track growing regions over time  
✅ **Quick sanity checks** — no need for heavy profilers  

For deeper analysis, combine with `/proc/<pid>/smaps`, `valgrind`, or `perf mem`.

## Resources

- [pmap(1) — Linux manual page](https://man7.org/linux/man-pages/man1/pmap.1.html) — official documentation
- `/proc/<pid>/maps` — raw kernel memory map
- `/proc/<pid>/smaps` — detailed per-region statistics
- `vmtouch` — check file cache residency
- `valgrind --tool=massif` — heap profiler
