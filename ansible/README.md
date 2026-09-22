Connect to your Ubuntu system -

```bash
sudo apt-get install software-properties-common
sudo apt-add-repository ppa:ansible/ansible
sudo apt-get update
sudo apt-get install ansible
```

<img width="1046" height="174" alt="image" src="https://github.com/user-attachments/assets/402cb239-608f-457c-8de2-5b169953a43c" />

How to run the playbook to connect on Cloud VM

```bash
ansible-playbook --inventory inventory/vm-setup-playbook/hosts vm-setup-playbook.yml
```

# Generate SSH key for connecting local machine to EC2 instance

```bash
ssh-keygen
chmod 400 key.pub
```

<img width="1007" height="403" alt="image" src="https://github.com/user-attachments/assets/f11e68b3-100d-4d75-9ba5-5afc9dddf61e" />

# Copy key.pub file to EC2 instance working directory -

```bash
scp -i /Users/TechEdx/Downloads/sshkey/demo.pem /Users/TechEdx/Downloads/sshkey/key.pub  ubuntu@ec2-52-33-144-205.us-west-2.compute.amazonaws.com:/home/ubuntu
key.pu
```

<img width="1857" height="50" alt="image" src="https://github.com/user-attachments/assets/f11dacec-bd9c-4fbd-895d-77447b6a19d1" />

# Check on EC2 instance -

<img width="250" height="40" alt="image" src="https://github.com/user-attachments/assets/8c756d12-bd8d-4c5c-bceb-b004475efb6d" />




