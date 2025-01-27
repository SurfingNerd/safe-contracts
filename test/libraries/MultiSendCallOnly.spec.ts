import { expect } from "chai";
import hre, { deployments, waffle } from "hardhat";
import "@nomiclabs/hardhat-ethers";
import { deployContract, getMock, getMultiSendCallOnly, getSafeWithOwners, getDelegateCaller } from "../utils/setup";
import {
    buildContractCall,
    buildSafeTransaction,
    executeTx,
    MetaTransaction,
    safeApproveHash,
    buildRawError,
} from "../../src/utils/execution";
import { buildMultiSendSafeTx } from "../../src/utils/multisend";
import { executeContractCallWithSigners } from "../../src/utils/execution";
import { parseEther } from "@ethersproject/units";

describe("MultiSendCallOnly", async () => {
    const [user1, user2] = waffle.provider.getWallets();

    const setupTests = deployments.createFixture(async ({ deployments }) => {
        await deployments.fixture();
        const setterSource = `
            contract StorageSetter {
                function setStorage(bytes3 data) public {
                    bytes32 slot = 0x4242424242424242424242424242424242424242424242424242424242424242;
                    // solhint-disable-next-line no-inline-assembly
                    assembly {
                        sstore(slot, data)
                    }
                }
            }`;
        const storageSetter = await deployContract(user1, setterSource);
        return {
            safe: await getSafeWithOwners([user1.address]),
            multiSend: await getMultiSendCallOnly(),
            mock: await getMock(),
            delegateCaller: await getDelegateCaller(),
            storageSetter,
        };
    });

    describe("multiSend", async () => {
        it("Should fail when using invalid operation", async () => {
            const { safe, multiSend } = await setupTests();

            const txs = [buildSafeTransaction({ to: user2.address, operation: 2, nonce: 0 })];
            const safeTx = buildMultiSendSafeTx(multiSend, txs, await safe.nonce());
            await expect(executeTx(safe, safeTx, [await safeApproveHash(user1, safe, safeTx, true)])).to.revertedWith("GS013");
        });

        it("Should fail when using delegatecall operation", async () => {
            const { safe, multiSend } = await setupTests();

            const txs = [buildSafeTransaction({ to: user2.address, operation: 1, nonce: 0 })];
            const safeTx = buildMultiSendSafeTx(multiSend, txs, await safe.nonce());
            await expect(executeTx(safe, safeTx, [await safeApproveHash(user1, safe, safeTx, true)])).to.revertedWith("GS013");
        });

        it("Can execute empty multisend", async () => {
            const { safe, multiSend } = await setupTests();

            const txs: MetaTransaction[] = [];
            const safeTx = buildMultiSendSafeTx(multiSend, txs, await safe.nonce());
            await expect(executeTx(safe, safeTx, [await safeApproveHash(user1, safe, safeTx, true)])).to.emit(safe, "ExecutionSuccess");
        });

        it("Can execute single ether transfer", async () => {
            const { safe, multiSend } = await setupTests();
            await user1.sendTransaction({ to: safe.address, value: parseEther("1") });
            const userBalance = await hre.ethers.provider.getBalance(user2.address);
            await expect(await hre.ethers.provider.getBalance(safe.address)).to.be.deep.eq(parseEther("1"));

            const txs: MetaTransaction[] = [buildSafeTransaction({ to: user2.address, value: parseEther("1"), nonce: 0 })];
            const safeTx = buildMultiSendSafeTx(multiSend, txs, await safe.nonce());
            await expect(executeTx(safe, safeTx, [await safeApproveHash(user1, safe, safeTx, true)])).to.emit(safe, "ExecutionSuccess");

            await expect(await hre.ethers.provider.getBalance(safe.address)).to.be.deep.eq(parseEther("0"));
            await expect(await hre.ethers.provider.getBalance(user2.address)).to.be.deep.eq(userBalance.add(parseEther("1")));
        });

        it("reverts all tx if any fails", async () => {
            const { safe, multiSend } = await setupTests();
            await user1.sendTransaction({ to: safe.address, value: parseEther("1") });
            const userBalance = await hre.ethers.provider.getBalance(user2.address);
            await expect(await hre.ethers.provider.getBalance(safe.address)).to.be.deep.eq(parseEther("1"));

            const txs: MetaTransaction[] = [
                buildSafeTransaction({ to: user2.address, value: parseEther("1"), nonce: 0 }),
                buildSafeTransaction({ to: user2.address, value: parseEther("1"), nonce: 0 }),
            ];
            const safeTx = buildMultiSendSafeTx(multiSend, txs, await safe.nonce(), { safeTxGas: 1 });
            await expect(executeTx(safe, safeTx, [await safeApproveHash(user1, safe, safeTx, true)])).to.emit(safe, "ExecutionFailure");

            await expect(await hre.ethers.provider.getBalance(safe.address)).to.be.deep.eq(parseEther("1"));
            await expect(await hre.ethers.provider.getBalance(user2.address)).to.be.deep.eq(userBalance);
        });

        it("can be used when ETH is sent with execution", async () => {
            const { safe, multiSend, storageSetter } = await setupTests();

            const txs: MetaTransaction[] = [buildContractCall(storageSetter, "setStorage", ["0xbaddad"], 0)];
            const safeTx = buildMultiSendSafeTx(multiSend, txs, await safe.nonce());

            await expect(await hre.ethers.provider.getBalance(safe.address)).to.be.deep.eq(parseEther("0"));

            await expect(executeTx(safe, safeTx, [await safeApproveHash(user1, safe, safeTx, true)], { value: parseEther("1") })).to.emit(
                safe,
                "ExecutionSuccess",
            );

            await expect(await hre.ethers.provider.getBalance(safe.address)).to.be.deep.eq(parseEther("1"));
        });

        it("can execute contract calls", async () => {
            const { safe, multiSend, storageSetter } = await setupTests();

            const txs: MetaTransaction[] = [buildContractCall(storageSetter, "setStorage", ["0xbaddad"], 0)];
            const safeTx = buildMultiSendSafeTx(multiSend, txs, await safe.nonce());
            await expect(executeTx(safe, safeTx, [await safeApproveHash(user1, safe, safeTx, true)])).to.emit(safe, "ExecutionSuccess");

            await expect(
                await hre.ethers.provider.getStorageAt(safe.address, "0x4242424242424242424242424242424242424242424242424242424242424242"),
            ).to.be.eq("0x" + "".padEnd(64, "0"));
            await expect(
                await hre.ethers.provider.getStorageAt(
                    storageSetter.address,
                    "0x4242424242424242424242424242424242424242424242424242424242424242",
                ),
            ).to.be.eq("0x" + "baddad".padEnd(64, "0"));
        });

        it("can execute combinations", async () => {
            const { safe, multiSend, storageSetter } = await setupTests();
            await user1.sendTransaction({ to: safe.address, value: parseEther("1") });
            const userBalance = await hre.ethers.provider.getBalance(user2.address);
            await expect(await hre.ethers.provider.getBalance(safe.address)).to.be.deep.eq(parseEther("1"));

            const txs: MetaTransaction[] = [
                buildSafeTransaction({ to: user2.address, value: parseEther("1"), nonce: 0 }),
                buildContractCall(storageSetter, "setStorage", ["0xbaddad"], 0),
            ];
            const safeTx = buildMultiSendSafeTx(multiSend, txs, await safe.nonce());
            await expect(executeTx(safe, safeTx, [await safeApproveHash(user1, safe, safeTx, true)])).to.emit(safe, "ExecutionSuccess");

            await expect(await hre.ethers.provider.getBalance(safe.address)).to.be.deep.eq(parseEther("0"));
            await expect(await hre.ethers.provider.getBalance(user2.address)).to.be.deep.eq(userBalance.add(parseEther("1")));
            await expect(
                await hre.ethers.provider.getStorageAt(safe.address, "0x4242424242424242424242424242424242424242424242424242424242424242"),
            ).to.be.eq("0x" + "".padEnd(64, "0"));
            await expect(
                await hre.ethers.provider.getStorageAt(
                    storageSetter.address,
                    "0x4242424242424242424242424242424242424242424242424242424242424242",
                ),
            ).to.be.eq("0x" + "baddad".padEnd(64, "0"));
        });

        it("can bubble up revert message on call", async () => {
            const { delegateCaller, multiSend, mock } = await setupTests();

            const triggerCalldata = "0xbaddad";
            const errorMessage = "Some random message";

            await mock.givenCalldataRevertWithMessage(triggerCalldata, errorMessage);

            const txs: MetaTransaction[] = [
                {
                    to: mock.address,
                    value: 0,
                    data: triggerCalldata,
                    operation: 0,
                },
            ];
            const { data } = buildMultiSendSafeTx(multiSend, txs, 0);

            await expect(delegateCaller.callStatic.makeDelegatecall(multiSend.address, data)).to.be.revertedWith(errorMessage);
        });
    });
});
