# Running CDAD on Kubernetes

These manifests run the same image Docker Compose builds, on any Kubernetes
cluster. The steps below use the one built into Docker Desktop.

| File | What it creates |
|---|---|
| `namespace.yaml` | the `cdad` namespace |
| `pvc.yaml` | `cdad-data`, a 1 Gi persistent volume for `/app/server/data` |
| `deployment.yaml` | 2 replicas of the app, with health checks and resource limits |
| `service.yaml` | a LoadBalancer on port **8080** (Docker Desktop publishes it on `localhost:8080`) |
| `kustomization.yaml` | lets `kubectl apply -k k8s` apply all of the above |

The database and uploaded files are in Supabase (`DATABASE_URL`, `SUPABASE_*`),
so the pods hold no state of their own. Logins are stored in the database, so
any replica can serve any request. Without `DATABASE_URL` the app would use a
SQLite file on the volume instead. In that case set `replicas: 1`.

## Run it (Docker Desktop)

1. Docker Desktop → Settings → **Kubernetes** → **Enable Kubernetes** → Apply & restart.
2. From the project root (`CBAD-project/`):

   ```bash
   docker compose build                    # builds the image cbad-project-cdad:latest
   kubectl create namespace cdad           # skip if it already exists
   kubectl -n cdad create secret generic cdad-env --from-env-file=backend/.env
   kubectl apply -k k8s
   kubectl -n cdad rollout status deployment/cdad
   ```

3. Open **http://localhost:8080**.

### On a kind cluster (e.g. `kind create cluster --name local`)

kind runs Kubernetes inside a Docker container, so it can't see images built by
Docker, and it has no load balancer. Load the image after every build, and
reach the app through a port-forward:

```bash
docker compose build
docker save cbad-project-cdad:latest | docker exec -i local-control-plane ctr -n k8s.io images import -
#   (or, with the kind CLI: kind load docker-image cbad-project-cdad:latest --name local)
kubectl -n cdad create secret generic cdad-env --from-env-file=backend/.env --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -k k8s
kubectl -n cdad port-forward svc/cdad 8080:8080     # keep this running, then open http://localhost:8080
```

The Service's `EXTERNAL-IP` stays `<pending>` on kind. That is expected; the port-forward replaces it.

## Everyday commands

```bash
kubectl -n cdad get pods,svc,pvc                  # what is running
kubectl -n cdad logs -l app=cdad -f               # logs from all replicas
kubectl -n cdad scale deployment/cdad --replicas=3
docker compose build && kubectl -n cdad rollout restart deployment/cdad   # deploy a code change
kubectl delete -k k8s                             # remove everything (the namespace, pods and volume)
```

After changing `backend/.env`, recreate the secret and restart the pods:

```bash
kubectl -n cdad create secret generic cdad-env --from-env-file=backend/.env --dry-run=client -o yaml | kubectl apply -f -
kubectl -n cdad rollout restart deployment/cdad
```

On a real cluster, push the image to a registry, set `image:` to it, and remove
`imagePullPolicy: Never`.
