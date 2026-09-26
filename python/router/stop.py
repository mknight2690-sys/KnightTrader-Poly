import subprocess, re, sys, os
sys.stdout.reconfigure(encoding="utf-8")

killed = []

# 1) Kill anything listening on router port 8082
r = subprocess.run(["netstat","-ano"], capture_output=True, text=True)
pids = set()
for line in r.stdout.splitlines():
    if ":8083" in line and "LISTENING" in line:
        m = re.search(r"\s(\d+)\s*$", line)
        if m: pids.add(m.group(1))
for pid in pids:
    subprocess.run(["taskkill","/F","/PID",pid], capture_output=True)
    killed.append(("router:"+pid))

# 2) Kill ngrok processes
r2 = subprocess.run(["tasklist"], capture_output=True, text=True)
for line in r2.stdout.splitlines():
    if "ngrok.exe" in line.lower():
        m = re.match(r"\S+\s+(\d+)", line)
        if m:
            subprocess.run(["taskkill","/F","/PID",m.group(1)], capture_output=True)
            killed.append(("ngrok:"+m.group(1)))

print("Killed:", killed or "nothing was running")
