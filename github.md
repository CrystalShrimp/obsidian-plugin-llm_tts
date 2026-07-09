# GitHub 仓库操作流程

以 `CrystalShrimp/CrystalShrimp.github.io` 为例，记录从 clone 到 push 的完整流程。

## 0. 前置检查（一次性，配好就不用再管）

```bash
# 确认 git 用户名/邮箱已配置
git config --global user.name    # 例：CrystalShrimp
git config --global user.email   # 例：shuman0805@163.com

# 确认 SSH key 能访问 GitHub
ssh -T git@github.com
# 成功提示：Hi CrystalShrimp! You've successfully authenticated...
```

## 1. 克隆仓库

```bash
cd "D:/ForRunning/ForDev/0_main_website"
git clone git@github.com:CrystalShrimp/CrystalShrimp.github.io.git
```

克隆后目录：`CrystalShrimp.github.io/`，内含 `README.md`、`index.html`、`posts/`。

## 2. 查看仓库状态

```bash
cd CrystalShrimp.github.io
git log --oneline -5     # 看最近提交风格（这里都是 "Update xxx.html"）
git branch -a            # 确认分支，主分支是 main
ls -la                   # 看文件结构
```

## 3. 修改文件

直接编辑目标文件即可。例如给 `README.md` 追加一行 `hello`。

## 4. 检查改动

```bash
git status               # 看哪些文件被修改
git diff README.md       # 看具体 diff，确认改动符合预期
```

## 5. 提交

```bash
git add README.md        # 只暂存目标文件，避免误提交其他改动
git commit -m "Update README.md"   # message 风格跟随仓库历史
```

## 6. 推送

```bash
git push origin main     # 推到远程 main 分支
```

成功输出示例：`f8ff330..6866faf  main -> main`

## 7. 后续再次改动

仓库已克隆到本地后，下次只需要：

```bash
cd "D:/ForRunning/ForDev/0_main_website/CrystalShrimp.github.io"
git pull                 # 先拉取远程最新，避免冲突
# ... 编辑文件 ...
git status && git diff <file>
git add <file>
git commit -m "Update <file>"
git push origin main
```

## 注意事项

- **不要把这份 `github.md` 放进仓库目录**，否则会被 git 追踪成未提交文件。放在仓库外层目录即可。
- `git add` 尽量指定具体文件名，不要用 `git add .` / `git add -A`，避免误提交敏感文件或大文件。
- commit message 跟随仓库现有风格（本仓库历史都是简短的 `Update xxx`）。
- 推送前用 `git diff` 复核改动；推送是远程可见的操作，谨慎对待。
