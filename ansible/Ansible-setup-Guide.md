# Ansible EC2 Setup Guide (WSL)

This project provisions an EC2 instance via Ansible, run from WSL (Windows Subsystem for Linux).

## Prerequisites

- WSL installed with a Linux distro (e.g. Ubuntu)
- Ansible installed inside WSL
- AWS account with an EC2 instance launched (Ubuntu AMI)

> ⚠️ **Important:** Keep this entire project inside WSL's native filesystem (e.g. `~/ansible-intro`) — **not** under `/mnt/c/...` or any Windows-mounted drive. Windows-mounted paths don't support proper Unix file permissions, which breaks SSH key authentication.

## Project Structure

```
ansible-intro/
├── ansible.cfg
├── inventory/
│   └── vm-setup-playbook/
│       ├── hosts
│       └── key (+ key.pub)
├── roles/
│   └── python/
│       └── tasks/
│           └── main.yml
└── vm-setup-ansible-playbook.yml
```

## Setup Steps

### 1. Create the project directory (in WSL)

```bash
cd ~
mkdir -p ansible-intro/inventory/vm-setup-playbook
mkdir -p ansible-intro/roles/python/tasks
cd ansible-intro
```

### 2. Generate an SSH keypair (in WSL)

```bash
ssh-keygen -t ed25519 -f inventory/vm-setup-playbook/key -N ""
chmod 600 inventory/vm-setup-playbook/key
```

### 3. Launch an EC2 instance (AWS Console)

- AMI: Ubuntu Server (LTS)
- Instance type: `t2.micro` (free tier)
- Key pair: create/download one (e.g. `ansible-server-login-key.pem`) **or** import your own `key.pub` directly during launch
- Security group: allow inbound SSH (port 22) from your IP

### 4. Authorize your WSL-generated key on the instance

If you used an AWS-issued `.pem` key pair at launch:

```bash
# Move the downloaded .pem into WSL (adjust path as needed)
cp /mnt/c/Users/<you>/Downloads/ansible-server-login-key.pem ~/ansible-intro/inventory/vm-setup-playbook/
chmod 600 ~/ansible-intro/inventory/vm-setup-playbook/ansible-server-login-key.pem

# Connect using the AWS-issued key
ssh -i inventory/vm-setup-playbook/ansible-server-login-key.pem ubuntu@<EC2_PUBLIC_IP>
```

While connected, append your WSL-generated public key so you can use it going forward:

```bash
# On your LOCAL machine, in a separate terminal:
cat inventory/vm-setup-playbook/key.pub

# On the EC2 instance (inside the SSH session), paste the output:
echo "<paste key.pub contents here>" >> ~/.ssh/authorized_keys
```

Exit the SSH session (`exit`).

### 5. Test SSH with your own key

```bash
ssh -i inventory/vm-setup-playbook/key ubuntu@<EC2_PUBLIC_IP>
```

If this connects successfully, you're ready to proceed.

### 6. Configure the inventory `hosts` file

`inventory/vm-setup-playbook/hosts`:

```ini
[default]
<EC2_PUBLIC_IP> ansible_ssh_private_key_file=inventory/vm-setup-playbook/key
```

### 7. Create the playbook

`vm-setup-ansible-playbook.yml`:

```yaml
---
- name: Example Ansible playbook
  hosts: all
  remote_user: ubuntu
  roles:
    - python
```

### 8. Create the role task

`roles/python/tasks/main.yml`:

```yaml
---
- name: Creates directory
  file:
    path: ./basic-http-server
    state: directory
```

### 9. Add `ansible.cfg`

```ini
[defaults]
host_key_checking = False
```

This avoids interactive host-key confirmation prompts on repeated/automated runs.

### 10. Run the playbook

```bash
ansible-playbook --inventory inventory/vm-setup-playbook/hosts vm-setup-ansible-playbook.yml
```

Expected result: `PLAY RECAP` with `ok=2`, no `unreachable` or `failed`.

## Troubleshooting Notes

| Symptom | Likely Cause | Fix |
|---|---|---|
| `Host key verification failed` | Host not yet in `known_hosts` | SSH in manually once and accept the fingerprint (`yes`), or set `host_key_checking = False` |
| `Permission denied (publickey)` | Wrong/missing key, or key not in `authorized_keys` on EC2 | Verify with `ssh-keygen -y -f key` and compare against `~/.ssh/authorized_keys` on the instance |
| `Bad permissions` / `UNPROTECTED PRIVATE KEY FILE` (Windows) | Private key file ACLs too open (common on non-WSL/Windows drives) | Use `icacls` to restrict access, or (preferred) keep keys inside WSL's native filesystem where `chmod 600` works correctly |
| `Identity file ... not accessible` | Wrong/relative path in `hosts` file, or wrong working directory | Confirm `pwd` and that the path in `ansible_ssh_private_key_file` is correct relative to where you run `ansible-playbook` |
