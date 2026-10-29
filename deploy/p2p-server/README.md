# Deploying p2p-server

p2p-server (device registry and relay, see
[server/cmd/p2p-server/README.md](../../server/cmd/p2p-server/README.md)) runs
as a Docker container on one Tencent Cloud host. The
[Deploy p2p-server](../../.github/workflows/deploy-p2p.yml) workflow runs on
every push to `main` that touches it, or on demand from the Actions tab:

1. Test, build the image from [Dockerfile](Dockerfile) and push it to Tencent
   Container Registry (TCR) as `ccr.ccs.tencentyun.com/<namespace>/p2p-server:<sha>`.
2. Send [deploy.sh](deploy.sh) to the host through Tencent Cloud Automation
   Tools (TAT) and wait for its result. The workflow never logs in to the host.
3. Check `http://<public IP>:8090/healthz` from outside (warning only).

`deploy.sh` runs as root on the host. It is idempotent: the first run installs
Docker and creates the configuration, so the host needs no manual setup. Each
run pulls the tag, replaces the container, health-checks it for 30 seconds and
restarts the previous tag if the check fails.

## Layout on the host

```
/etc/multica-p2p/env            configuration, created on the first deploy (see below)
/var/lib/multica-p2p/           p2p.db, p2p-server.key (relay identity), owned by uid 10001
/var/lib/multica-p2p-deploy/    the live tag
container multica-p2p           host networking, read-only root, all capabilities dropped
```

## One-time setup

### Tencent Cloud

1. **TCR personal edition** (region: Guangzhou, same as the host): create a
   namespace and a repository named `p2p-server`. Make the repository
   **public**: the image only contains the open-source binary, and a public
   repository lets the host pull without registry credentials. Set the
   registry password; the username is the main account ID.

2. **Firewall** (Lighthouse instance → 防火墙): allow `TCP 8090`, `TCP 4001`
   and `UDP 4001` from all IPv4 addresses. SSH is not needed for deploys.

3. **TAT agent**: on the instance page, check that Automation Tools
   (自动化助手) shows the agent online. Lighthouse images ship it.

4. **CAM sub-user** for the workflow (访问管理 → 用户 → 新建用户 → 编程访问),
   with only this policy:

   ```json
   {
     "version": "2.0",
     "statement": [
       {
         "effect": "allow",
         "action": ["tat:RunCommand", "tat:DescribeInvocationTasks"],
         "resource": ["*"]
       }
     ]
   }
   ```

   Its API key can run commands as root on the instances of this account, so
   keep it only in GitHub.

### GitHub

Enable Actions for the repository first: a fork starts with Actions disabled
(Actions tab → enable, and Settings → Actions → General → allow actions).

Environment `production` secrets (Settings → Environments → production):

| Secret | Value |
| --- | --- |
| `TCR_USERNAME` | Tencent Cloud main account ID |
| `TCR_PASSWORD` | TCR registry password |
| `TENCENTCLOUD_SECRET_ID` | CAM sub-user SecretId |
| `TENCENTCLOUD_SECRET_KEY` | CAM sub-user SecretKey |

Repository variables (Settings → Secrets and variables → Actions → Variables):

| Variable | Value |
| --- | --- |
| `TCR_NAMESPACE` | TCR namespace |
| `P2P_INSTANCE_ID` | Lighthouse instance ID (`lhins-…`) |
| `P2P_PUBLIC_IP` | Instance public IP |
| `TENCENTCLOUD_REGION` | Optional, default `ap-guangzhou` |
| `P2P_PLATFORM` | Optional, default `linux/amd64` (`linux/arm64` for ARM hosts) |

Then run the workflow from the Actions tab.

## Configuration

The first deploy writes `/etc/multica-p2p/env` with the defaults from
[server/cmd/p2p-server/README.md](../../server/cmd/p2p-server/README.md) and
`MULTICA_P2P_PUBLIC_IP` from the `P2P_PUBLIC_IP` variable. Later deploys only
update `MULTICA_P2P_PUBLIC_IP`; other edits made on the host are kept and take
effect on the next deploy or `docker restart multica-p2p`.

Before relying on the service, check that the host reaches the Multica API,
since every new session is verified there (TAT → 执行命令, or OrcaTerm):

```sh
curl -m 10 -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://api.multica.ai/api/me   # 401 is expected
```

## Operations

- Logs: `docker logs -f multica-p2p`. A relay usage summary is logged every
  five minutes; refused relay connections are logged with their reason.
- Live tag: `cat /var/lib/multica-p2p-deploy/current`.
- Manual rollback: re-run the workflow with an older commit as `ref`.
- Keep `/var/lib/multica-p2p/p2p-server.key`: losing it changes the relay peer
  ID. Daemons fetch the relay address from the registry and recover on their
  next refresh, but existing relay reservations are dropped.
- Relayed traffic counts against the Lighthouse monthly traffic allowance.
