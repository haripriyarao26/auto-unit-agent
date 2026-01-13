/**
 * Math utility functions with complex edge cases
 */

/**
 * Calculates compound interest with various edge cases
 * 
 * @param principal - Initial amount
 * @param rate - Annual interest rate (as decimal, e.g., 0.05 for 5%)
 * @param time - Time period in years
 * @param compoundingFrequency - Number of times interest is compounded per year (default: 12 for monthly)
 * @returns Final amount after compound interest
 * 
 * Edge cases:
 * - Zero or negative principal
 * - Zero or negative rate
 * - Zero or negative time
 * - Zero or negative compounding frequency
 * - Very large numbers
 * - Very small numbers (precision issues)
 */
export function calculateCompoundInterest(
  principal: number,
  rate: number,
  time: number,
  compoundingFrequency: number = 12
): number {
  // Handle edge cases
  if (principal <= 0) {
    throw new Error('Principal must be greater than zero');
  }
  
  if (rate < 0) {
    throw new Error('Interest rate cannot be negative');
  }
  
  if (time <= 0) {
    throw new Error('Time period must be greater than zero');
  }
  
  if (compoundingFrequency <= 0) {
    throw new Error('Compounding frequency must be greater than zero');
  }
  
  // If rate is zero, return principal
  if (rate === 0) {
    return principal;
  }
  
  // Compound interest formula: A = P(1 + r/n)^(nt)
  const base = 1 + rate / compoundingFrequency;
  const exponent = compoundingFrequency * time;
  const result = principal * Math.pow(base, exponent);
  
  // Handle potential overflow
  if (!isFinite(result)) {
    throw new Error('Result exceeds maximum representable number');
  }
  
  return Math.round(result * 100) / 100; // Round to 2 decimal places
}

