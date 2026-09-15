https://www.getfoundry.sh/introduction/installation <br>
<br>
<br>
# Installation
Foundry is installed using foundryup, the official installer and version manager.<br>
<br>
# Install foundryup

```bash
curl -L https://getfoundry.sh/install | bash
```

# Restart your terminal

```bash
Or run source ~/.bashrc / source ~/.zshrc.
```

#  Install Foundry

```bash
foundryup
```

This installs the latest stable versions of forge, cast, anvil, and chisel.

<img width="1897" height="976" alt="image" src="https://github.com/user-attachments/assets/686f9c19-e821-40b0-a873-971b1c1ef8c1" />

## Check installation

```bash
forge --version
```

<img width="567" height="102" alt="image" src="https://github.com/user-attachments/assets/475869fb-666b-49a7-8054-3d42035f245e" />


## VSCode setup

### Install extensions -

Github Copilot <br>
Github Copilot labs <br>
Solidity <br>
Even Better TOML <br>
 <br>
  <br>

# Foundry basic commands

```bash
Build project -

foundry build
```

# Anvil

Anvil is a fast local Ethereum node for development and testing. It runs entirely in-memory and supports forking from any EVM-compatible chain.

<img width="1384" height="675" alt="image" src="https://github.com/user-attachments/assets/5f179328-a735-4fd5-866c-a9eefdabf30f" />
<img width="1384" height="748" alt="image" src="https://github.com/user-attachments/assets/9ded4050-7066-4536-b7db-7c4def2116d4" />
<img width="1384" height="410" alt="image" src="https://github.com/user-attachments/assets/ad957ebc-9c9d-41b8-af90-980c6da21e00" />



   <br>
    <br>

# Add Anvil network in Metamask -

<img width="811" height="699" alt="image" src="https://github.com/user-attachments/assets/c54e5fee-2b0a-42c5-9a4b-48ca6a1b1a06" />

     <br>
      <br>

# Deploy contract to Anvil

```bash
forge create Test  --rpc-url http://127.0.0.1:8545 --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

<br>
<img width="1212" height="604" alt="image" src="https://github.com/user-attachments/assets/63bd89d8-bc09-471b-b9ee-565c98e7a94f" />

<br>
<br>

# Install OpenZeppelin Contracts

```bash
git init
git add .
git commit -m "Initial commit"
forge install OpenZeppelin/OpenZeppelin-contracts
```

<img width="1329" height="746" alt="image" src="https://github.com/user-attachments/assets/ea77e47d-5997-4e8e-9466-33bc4d90e4d4" />

<br>
<br>

# Install OpenZeppelin Upgradable Contracts

```bash
forge
install OpenZeppelin/openzeppelin-contracts-upgradeable
```

<img width="1357" height="874" alt="image" src="https://github.com/user-attachments/assets/b3a60bc3-1a2d-4a85-b8d8-5c2d4bd38a4e" />

<br>
<br>

```bash
# Remove existing OpenZeppelin installs
forge remove OpenZeppelin/openzeppelin-contracts
forge remove OpenZeppelin/openzeppelin-contracts-upgradeable

# Install OpenZeppelin v5.7.0 (standard + upgradeable)
forge install OpenZeppelin/openzeppelin-contracts@v5.7.0
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.7.0
```

<br>
<br>

```bash
check version of openzepplin standard & upgradeable directly via git tags/commits in each lib
git -C lib/openzeppelin-contracts describe --tags
git -C lib/openzeppelin-contracts-upgradeable describe --tags
```
<br>
<br>

# Install ETH Infinitism Account Abstraction
only needed for ClaimGasPaymaster.sol

```bash
forge install eth-infinitism/account-abstraction
```

That command prints the full commit hash that lib/openzeppelin-contracts is currently checked out at -C <path> tells git "run this command as if you wouldd cd into <path> first," without actually changing your shell's working directory. So instead of doing:

```bash
cd lib/openzeppelin-contracts
git rev-parse HEAD
cd -   # back to where you were
```

<br>
<br>

### rev-parse

A low-level git command that turns a human-readable reference (a branch name, tag, or symbolic ref like HEAD) into its actual SHA-1 commit hash. Think of it as "resolve this name to the real underlying identifier."

### HEAD

A pointer to whatever commit your working directory is currently checked out at — literally "the current position." In a submodule context like this, HEAD will point to whatever commit forge install checked out (since forge pins submodules to a specific commit, not a floating branch).

Put together: the command answers "what exact commit is this OpenZeppelin submodule sitting on right now?" — output looks like:

```bash
c1cbb90a9e7f2ea3a3234ba1d4e8f4b1a3c0a5db
```

### To connect that hash back to a version tag, you can run:

```bash
git -C lib/openzeppelin-contracts tag --points-at HEAD
```

which lists any tags (like v5.7.0) attached to that exact commit — if it comes back empty, you're on a commit that isn't tagged (possibly ahead of or between releases).
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>


