.PHONY: deploy setup logs ssh

# 部署最新程式碼到主機
deploy:
	@bash scripts/deploy.sh

# 第一次部署（clone + docker compose up）
setup:
	@bash scripts/deploy.sh --setup

# 看主機 log
logs:
	@source .env.deploy && \
	  ssh -p $${DEPLOY_PORT:-22} -i $${DEPLOY_KEY:-~/.ssh/id_rsa} \
	  "$$DEPLOY_USER@$$DEPLOY_HOST" \
	  "cd $$DEPLOY_DIR && docker compose logs -f"

# 直接 SSH 進主機
ssh:
	@source .env.deploy && \
	  ssh -p $${DEPLOY_PORT:-22} -i $${DEPLOY_KEY:-~/.ssh/id_rsa} \
	  "$$DEPLOY_USER@$$DEPLOY_HOST"
