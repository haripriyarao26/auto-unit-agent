/**
 * LeetCode 322: Coin Change (BUGGY VERSION)
 * Find the fewest coins to make up an amount. 
 * If it can't be made, return -1.
 */
export function coinChange(coins: number[], amount: number): number {
    const dp = new Array(amount + 1).fill(Infinity);
    dp[0] = 0;
  
    for (const coin of coins) {
      for (let i = coin; i <= amount; i++) {
        dp[i] = Math.min(dp[i], dp[i - coin] + 1);
      }
    }
  
    // BUG: This should return -1 if dp[amount] is Infinity
    // But we are returning it as is, which will fail tests.
    return dp[amount]; 
  }