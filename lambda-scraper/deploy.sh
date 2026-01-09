#!/bin/bash
# Deployment script for Bitcoin News Scraper Lambda
# This script automates the deployment process

set -e  # Exit on error

echo "=== Bitcoin News Scraper Lambda Deployment ==="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
FUNCTION_NAME="crypto-news-scraper"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="crypto-scraper-stack"

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI not found. Please install it first.${NC}"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js not found. Please install it first.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Prerequisites OK${NC}"
echo ""

# Install dependencies
echo "Installing dependencies..."
npm install --production
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo ""

# Create deployment package
echo "Creating deployment package..."
if [ -f function.zip ]; then
    rm function.zip
fi

zip -q -r function.zip index.js package.json node_modules/
echo -e "${GREEN}✓ Deployment package created ($(du -h function.zip | cut -f1))${NC}"
echo ""

# Check if using CloudFormation or direct deployment
read -p "Deploy using CloudFormation? (y/n) [y]: " use_cfn
use_cfn=${use_cfn:-y}

if [[ "$use_cfn" =~ ^[Yy]$ ]]; then
    # CloudFormation deployment
    echo ""
    echo "=== CloudFormation Deployment ==="
    echo ""
    
    # Prompt for parameters
    read -p "Cloudflare Account ID: " cf_account_id
    read -p "Cloudflare D1 Database ID: " cf_database_id
    read -sp "Cloudflare API Token: " cf_api_token
    echo ""
    echo "Chromium Layer ARN: Check latest version at https://github.com/Sparticuz/chromium/releases"
    read -p "Chromium Layer ARN [arn:aws:lambda:$REGION:764866452798:layer:chrome-aws-lambda:43]: " layer_arn
    layer_arn=${layer_arn:-arn:aws:lambda:$REGION:764866452798:layer:chrome-aws-lambda:43}
    
    # Create/update stack
    echo ""
    echo "Deploying CloudFormation stack..."
    
    aws cloudformation deploy \
        --template-file cloudformation.yaml \
        --stack-name "$STACK_NAME" \
        --parameter-overrides \
            CloudflareAccountId="$cf_account_id" \
            CloudflareD1DatabaseId="$cf_database_id" \
            CloudflareApiToken="$cf_api_token" \
            ChromiumLayerArn="$layer_arn" \
        --capabilities CAPABILITY_NAMED_IAM \
        --region "$REGION"
    
    echo -e "${GREEN}✓ CloudFormation stack deployed${NC}"
    
    # Update function code
    echo ""
    echo "Updating function code..."
    aws lambda update-function-code \
        --function-name "$FUNCTION_NAME" \
        --zip-file fileb://function.zip \
        --region "$REGION" \
        > /dev/null
    
    echo -e "${GREEN}✓ Function code updated${NC}"
    
else
    # Direct AWS CLI deployment
    echo ""
    echo "=== Direct AWS CLI Deployment ==="
    echo ""
    
    # Prompt for parameters
    read -p "Cloudflare Account ID: " cf_account_id
    read -p "Cloudflare D1 Database ID: " cf_database_id
    read -sp "Cloudflare API Token: " cf_api_token
    echo ""
    echo "Chromium Layer ARN: Check latest version at https://github.com/Sparticuz/chromium/releases"
    read -p "Chromium Layer ARN [arn:aws:lambda:$REGION:764866452798:layer:chrome-aws-lambda:43]: " layer_arn
    layer_arn=${layer_arn:-arn:aws:lambda:$REGION:764866452798:layer:chrome-aws-lambda:43}
    
    # Get AWS account ID
    aws_account_id=$(aws sts get-caller-identity --query Account --output text)
    
    # Check if function exists
    if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" &> /dev/null; then
        echo ""
        echo "Function exists, updating..."
        
        # Update function code
        aws lambda update-function-code \
            --function-name "$FUNCTION_NAME" \
            --zip-file fileb://function.zip \
            --region "$REGION" \
            > /dev/null
        
        # Update function configuration
        aws lambda update-function-configuration \
            --function-name "$FUNCTION_NAME" \
            --timeout 20 \
            --memory-size 1024 \
            --layers "$layer_arn" \
            --environment Variables="{
                CLOUDFLARE_ACCOUNT_ID=$cf_account_id,
                CLOUDFLARE_D1_DATABASE_ID=$cf_database_id,
                CLOUDFLARE_API_TOKEN=$cf_api_token
            }" \
            --region "$REGION" \
            > /dev/null
        
        echo -e "${GREEN}✓ Function updated${NC}"
        
    else
        echo ""
        echo "Creating new function..."
        
        # Create IAM role if it doesn't exist
        if ! aws iam get-role --role-name crypto-scraper-lambda-role &> /dev/null; then
            echo "Creating IAM role..."
            
            cat > /tmp/trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
            
            aws iam create-role \
                --role-name crypto-scraper-lambda-role \
                --assume-role-policy-document file:///tmp/trust-policy.json \
                > /dev/null
            
            aws iam attach-role-policy \
                --role-name crypto-scraper-lambda-role \
                --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
            
            echo "Waiting for IAM role to propagate..."
            sleep 10
        fi
        
        # Create function
        aws lambda create-function \
            --function-name "$FUNCTION_NAME" \
            --runtime nodejs20.x \
            --role "arn:aws:iam::$aws_account_id:role/crypto-scraper-lambda-role" \
            --handler index.handler \
            --zip-file fileb://function.zip \
            --timeout 20 \
            --memory-size 1024 \
            --layers "$layer_arn" \
            --environment Variables="{
                CLOUDFLARE_ACCOUNT_ID=$cf_account_id,
                CLOUDFLARE_D1_DATABASE_ID=$cf_database_id,
                CLOUDFLARE_API_TOKEN=$cf_api_token
            }" \
            --region "$REGION" \
            > /dev/null
        
        echo -e "${GREEN}✓ Function created${NC}"
        
        # Create EventBridge rule
        echo ""
        echo "Creating EventBridge schedule..."
        
        aws events put-rule \
            --name crypto-scraper-schedule \
            --schedule-expression "rate(2 minutes)" \
            --state ENABLED \
            --region "$REGION" \
            > /dev/null
        
        aws events put-targets \
            --rule crypto-scraper-schedule \
            --targets "Id"="1","Arn"="arn:aws:lambda:$REGION:$aws_account_id:function:$FUNCTION_NAME" \
            --region "$REGION" \
            > /dev/null
        
        aws lambda add-permission \
            --function-name "$FUNCTION_NAME" \
            --statement-id AllowEventBridgeInvoke \
            --action lambda:InvokeFunction \
            --principal events.amazonaws.com \
            --source-arn "arn:aws:events:$REGION:$aws_account_id:rule/crypto-scraper-schedule" \
            --region "$REGION" \
            > /dev/null
        
        echo -e "${GREEN}✓ EventBridge schedule created${NC}"
    fi
fi

# Test the function
echo ""
read -p "Test the function now? (y/n) [y]: " do_test
do_test=${do_test:-y}

if [[ "$do_test" =~ ^[Yy]$ ]]; then
    echo ""
    echo "Testing function..."
    aws lambda invoke \
        --function-name "$FUNCTION_NAME" \
        --payload '{}' \
        --region "$REGION" \
        /tmp/response.json \
        > /dev/null
    
    echo ""
    echo "Response:"
    cat /tmp/response.json
    echo ""
    echo ""
fi

# Show monitoring commands
echo ""
echo -e "${GREEN}=== Deployment Complete! ===${NC}"
echo ""
echo "Monitor logs:"
echo "  aws logs tail /aws/lambda/$FUNCTION_NAME --follow --region $REGION"
echo ""
echo "Invoke manually:"
echo "  aws lambda invoke --function-name $FUNCTION_NAME --region $REGION response.json"
echo ""
echo "Check metrics:"
echo "  aws cloudwatch get-metric-statistics \\"
echo "    --namespace AWS/Lambda \\"
echo "    --metric-name Invocations \\"
echo "    --dimensions Name=FunctionName,Value=$FUNCTION_NAME \\"
echo "    --start-time \$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \\"
echo "    --end-time \$(date -u +%Y-%m-%dT%H:%M:%S) \\"
echo "    --period 300 \\"
echo "    --statistics Sum \\"
echo "    --region $REGION"
echo ""
