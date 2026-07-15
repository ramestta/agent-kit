"""Live testnet verification of the Python SDK (uses guarded.rama).

    DEPLOYER_KEY=0x... .venv/bin/python test_live.py
"""
import os
from web3 import Web3
from ramestta_agent_kit import Agent

key = os.environ["DEPLOYER_KEY"]
agent = Agent.connect("guarded", key)
tools = agent.tools()

print("info   →", tools["ramestta_agent_info"]())
print("quota  →", tools["ramestta_remaining_quota"]())
print("tasks  →", tools["ramestta_list_tasks"]())

# write path: real payment from the agent wallet via Python
deployer = Web3().eth.account.from_key(key).address
print("pay    →", tools["ramestta_send_payment"](deployer, "0.0001"))

# write path 2: the agent schedules its own recurring task from Python
mock_target = "0x6e7c8bd27e174d8ca91F45a4a31ea072a438aFAE"  # MockTarget.increment()
increment = Web3.keccak(text="increment()")[:4].hex()
print("sched  →", tools["ramestta_schedule_task"](mock_target, increment, 3600))
print("tasks  →", tools["ramestta_list_tasks"]())
print("✅ python SDK live verification complete")
