bucket         = "dispatcher-v2-tf-state"
key            = "dispatcher-v2/dev/terraform.tfstate"
region         = "eu-west-2"
encrypt        = true
dynamodb_table = "dispatcher-v2-tf-locks"
