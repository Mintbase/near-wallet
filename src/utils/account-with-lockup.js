import BN from 'bn.js'
import sha256 from 'js-sha256'
import { parseNearAmount } from 'near-api-js/lib/utils/format'
import { BinaryReader } from 'near-api-js/lib/utils/serialize'
import { LOCKUP_ACCOUNT_ID_SUFFIX } from './wallet'
import { WalletError } from './walletError'

export function decorateWithLockup(account) {
    // TODO: Use solution without hacky mix-in inheritance
    // TODO: Looks like best if near-api-js allows to specify transaction middleware

    let decorated = {...account, wrappedAccount: account, signAndSendTransaction, getAccountBalance };
    decorated.__proto__ = account.__proto__;
    return decorated;
}

async function signAndSendTransaction(receiverId, actions) {
    const { available: balance } = await this.getAccountBalance()

    // TODO: Should gas allowance be dynamically calculated
    const MIN_BALANCE_FOR_GAS = new BN(parseNearAmount('2'));
    // TODO: Extract code to compute total cost of transaction
    const total = actions.map(action => action?.transfer?.deposit || action?.functionCall?.deposit)
        .filter(deposit => !!deposit)
        .map(str => new BN(str))
        .reduce((a, b) => a.add(b), new BN("0"));

    const missingAmount = total.sub(new BN(balance)).add(MIN_BALANCE_FOR_GAS);
    if (missingAmount.gt(new BN(0))) {
        const lockupAccountId = getLockupAccountId(this.accountId)
        console.warn('Not enough balance on main account, checking lockup account', lockupAccountId);

        if (!(await this.wrappedAccount.viewFunction(lockupAccountId, 'are_transfers_enabled'))) {
            await this.wrappedAccount.functionCall(lockupAccountId, 'check_transfers_vote', {}, new BN(75000000000000))
        }

        const liquidBalance = new BN(await this.wrappedAccount.viewFunction(lockupAccountId, 'get_liquid_owners_balance'))
        if (!liquidBalance.gt(missingAmount)) {
            throw new WalletError('Not enough tokens.', 'sendMoney.amountStatusId.notEnoughTokens')
        }

        // TODO: better gas calculation (use base amount multiples)
        await this.wrappedAccount.functionCall(lockupAccountId, 'transfer', {
            // NOTE: Move all the liquid tokens to minimize transactions in the long run
            amount: liquidBalance.toString(),
            receiver_id: this.wrappedAccount.accountId
        }, new BN(50000000000000))

        // TODO: check if not in staking pool and then remove to take remainder (if balance is zero)
    }

    return await this.wrappedAccount.signAndSendTransaction.call(this, receiverId, actions);
}

function getLockupAccountId(accountId) {
    return sha256(Buffer.from(accountId)).substring(0, 40) + '.' + LOCKUP_ACCOUNT_ID_SUFFIX
}

async function getAccountBalance() {
    const balance = await this.wrappedAccount.getAccountBalance()

    // TODO: Should lockup contract balance be retrieved separately only when needed?
    const lockupAccountId = getLockupAccountId(this.accountId)
    console.log('lockupAccountId', lockupAccountId)
    try {
        // TODO: Makes sense for a lockup contract to return whole state as JSON instead of method per property
        let [
            ownersBalance,
            liquidOwnersBalance,
            lockedAmount,
        ] = await Promise.all([
            'get_owners_balance',
            'get_liquid_owners_balance',
            'get_locked_amount',
        ].map(methodName => this.viewFunction(lockupAccountId, methodName)))

        const {
            lockupAmount,
            releaseDuration,
            transferInformation,
        } = await viewLockupState(this.connection, lockupAccountId)

        const { transfer_poll_account_id } = transferInformation
        if (transfer_poll_account_id) {
            const transfersTimestamp = await this.viewFunction(transfer_poll_account_id, 'get_result')
            if (transfersTimestamp) {
                const endTimestamp = new BN(transfersTimestamp).add(new BN(releaseDuration))
                const timeLeft = endTimestamp.sub(new BN(Date.now()).mul(new BN('1000000')))
                const unreleasedAmount = BN.max(new BN(0), new BN(lockupAmount).mul(timeLeft).div(new BN(releaseDuration)))
                liquidOwnersBalance = new BN(lockupAmount).sub(unreleasedAmount)
            }
        }

        return {
            ...balance,
            ownersBalance,
            liquidOwnersBalance,
            lockedAmount,
            total: new BN(balance.total).add(new BN(lockedAmount)).add(new BN(ownersBalance)).toString()
        }
    } catch (error) {
        if (error.message.match(/Account ".+" doesn't exist/) || error.message.includes('cannot find contract code for account')) {
            return balance
        }
        throw error
    }
}

function readOption(reader, f) {
    let x = reader.read_u8();
    if (x === 1) {
        return f();
    }
    return null;
}

// NOTE: Taken from account-lookup project
// TODO: Client-library for lockup?
async function viewLockupState(connection, lockupAccountId) {
    const result = await connection.provider.sendJsonRpc("query", {
        request_type: "view_state",
        finality: "final",
        account_id: lockupAccountId,
        prefix_base64: Buffer.from('STATE', 'utf-8').toString('base64'),
    });
    let value = Buffer.from(result.values[0].value, 'base64');
    let reader = new BinaryReader(value);
    let owner = reader.read_string();
    let lockupAmount = reader.read_u128().toString();
    let terminationWithdrawnTokens = reader.read_u128().toString();
    let lockupDuration = reader.read_u64().toString();
    let releaseDuration = readOption(reader, () => reader.read_u64().toString());
    let lockupTimestamp = readOption(reader, () => reader.read_u64().toString());
    let tiType = reader.read_u8();
    let transferInformation;
    if (tiType === 0) {
        transferInformation = {
            transfers_timestamp: reader.read_u64()
        };
    } else {
        transferInformation = {
            transfer_poll_account_id: reader.read_string()
        };
    };
    let vestingType = reader.read_u8();
    let vestingInformation = null;
    if (vestingType === 1) {
        vestingInformation = { VestingHash: reader.read_array(() => reader.read_u8()) };
    } else if (vestingType === 2) {
        let vestingStart = reader.read_u64();
        let vestingCliff = reader.read_u64();
        let vestingEnd = reader.read_u64();
        vestingInformation = { vestingStart, vestingCliff, vestingEnd };
    } else if (vestingType === 3) {
        vestingInformation = 'TODO';
    }
    return {
        owner,
        lockupAmount,
        terminationWithdrawnTokens,
        lockupDuration,
        releaseDuration,
        lockupTimestamp,
        transferInformation,
        vestingInformation,
    }
}